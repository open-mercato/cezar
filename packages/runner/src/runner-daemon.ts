import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { RunnerClient, type ClaimedJob, type RunnerUtilizationPayload } from './runner-client.js';
import { executeJobLocally } from './execute-job-locally.js';
import { maintainBareClones } from './repo-clone.js';
import { redactToken } from './redact.js';

const execFileAsync = promisify(execFile);

const MAINTENANCE_TICKS = 60;
// Refresh the cached host GH token every 30 minutes. `gh auth token` is a
// short-lived OAuth token in practice (gh refreshes it on its own); we just
// re-read so we don't carry an expired value into a fresh job.
const HOST_TOKEN_REFRESH_MS = 30 * 60_000;
// How long the long-poll request blocks server-side. Must match the route's
// MAX_WAIT_SEC cap (see /api/runner/jobs/route.ts). The HTTP client adds
// 5s of slack on top.
const LONG_POLL_WAIT_SEC = 25;
// Brief sleep when at concurrency cap so we don't busy-loop. The heartbeat
// timer runs independently, so leases keep getting renewed during this nap.
const AT_CAPACITY_SLEEP_MS = 250;

export interface RunnerDaemonConfig {
  url: string;
  token: string;
  /** Backends this runner advertises (and the `claim` filter). */
  backends: string[];
  kind: 'cloud' | 'self-hosted';
  /** Max concurrent jobs. Default 1. */
  concurrency?: number;
  /** Seconds between claim attempts (and the heartbeat is sent every other tick). Default 1. */
  pollIntervalSec?: number;
  /** Phase 4 (migration 0026) — mint GitHub tokens locally from `gh auth
   *  token` / GITHUB_TOKEN instead of asking the SaaS to mint them. The
   *  daemon advertises this on heartbeat so the central updates
   *  `runners.github_inherit_host`. */
  githubInheritHost?: boolean;
  /** Phase 4 (migration 0026) — advertise a per-runner GitHub App install id.
   *  Mutually exclusive with `githubInheritHost` (the latter wins server-side). */
  githubInstallationId?: number | null;
}

interface InFlight {
  jobId: string;
  workflowRunId: string;
  pause: boolean;
  cancel: boolean;
  /** Phase 3: set when the SaaS heartbeat reports our lease was NOT renewed
   *  for this job — the watchdog has reclaimed it. Treated like a cancel:
   *  the engine's between-step probe stops the run promptly. */
  leaseLost: boolean;
  done: Promise<void>;
}

/**
 * The runner loop: long-polls the SaaS for jobs it can serve, runs them locally
 * (streaming events back), heartbeats so the watchdog knows it's alive, and on
 * SIGINT/SIGTERM stops claiming, lets in-flight jobs finish (grace timeout),
 * sends a final `offline` heartbeat.
 *
 * Pause/cancel reach a running job via the heartbeat reply (`cancelJobIds` /
 * `pauseRunIds`) — no separate poll. The daemon flips a per-job flag the job's
 * pause/cancel probes read between steps.
 */
export class RunnerDaemon {
  private readonly client: RunnerClient;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly inFlight = new Map<string, InFlight>();
  private stopping = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private hostTokenTimer: NodeJS.Timeout | null = null;
  private idleTicks = 0;
  /** Phase 4 (migration 0026) — cached host GH token for inherit-host mode.
   *  Read from `gh auth token`, falls back to `process.env.GITHUB_TOKEN`.
   *  Refreshed every 30 min. Null on hosts where neither is available. */
  private hostGithubToken: string | null = null;
  /** Phase 5 (migration 0027) — runner's own UUID, learned from the heartbeat
   *  reply on first round-trip. Stamped onto `step-start` events so the
   *  central populates `agent_runs.runner_id`. Null until the central has
   *  echoed it back at least once. */
  private runnerId: string | null = null;

  constructor(private readonly cfg: RunnerDaemonConfig) {
    this.client = new RunnerClient(cfg.url, cfg.token);
    this.concurrency = Math.max(1, cfg.concurrency ?? 1);
    this.pollMs = Math.max(1000, (cfg.pollIntervalSec ?? 1) * 1000);
  }

  async start(): Promise<void> {
    process.on('SIGINT', () => {
      void this.shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void this.shutdown('SIGTERM');
    });

    // Global safety nets: a stray rejection/exception must never leave the
    // daemon "online but mute" (heartbeat still reporting green while the
    // pump is dead and jobs queue indefinitely). An unhandled rejection is
    // logged but tolerated; an uncaught exception is fatal, so we shut down.
    process.on('unhandledRejection', (reason) => {
      console.error(
        '[runner] unhandledRejection:',
        reason instanceof Error ? (reason.stack ?? reason.message) : reason,
      );
    });
    process.on('uncaughtException', (err) => {
      console.error(
        '[runner] uncaughtException:',
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      void this.shutdown('uncaught-exception');
    });

    console.log(
      `[runner] starting — kind=${this.cfg.kind} backends=${this.cfg.backends.join(',')} concurrency=${this.concurrency}`,
    );

    // Phase 4 — prime the host GH token cache before the first heartbeat so
    // a claim landing seconds after startup already has a token to substitute.
    // We hard-fail if inherit-host is requested but no token is reachable —
    // a misconfigured runner that claims jobs it can't actually authenticate
    // for would just thrash the queue.
    if (this.cfg.githubInheritHost) {
      this.hostGithubToken = await readHostGithubToken();
      if (!this.hostGithubToken) {
        console.error(
          '[runner] --inherit-host-github set but no token found: install `gh` and run `gh auth login`, or set GITHUB_TOKEN. Refusing to start.',
        );
        process.exit(1);
      }
      console.log('[runner] inherit-host-github: cached host GitHub token');
      this.hostTokenTimer = setInterval(() => {
        void this.refreshHostGithubToken();
      }, HOST_TOKEN_REFRESH_MS);
    }

    await this.heartbeat('online');

    // Heartbeat cadence stays at 2x pollMs (default 2s). With a 60s lease the
    // SaaS sees ~30 renewals per window — plenty of slack for a hiccup. Lease
    // renewal lives in the heartbeat (carries `inflightJobIds`), so the
    // cadence is now lease-critical and MUST NOT be loosened.
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat('online');
    }, this.pollMs * 2);

    // Pump loop: replaces the 1s setInterval short-poll with a long-poll
    // (LISTEN/NOTIFY on the SaaS side, migration 0025). After every response
    // (claim or 25s timeout) we immediately loop again — no extra setTimeout
    // wake-up needed. When at concurrency cap we nap briefly so the heartbeat
    // still gets airtime and we don't burn CPU.
    const pump = async (): Promise<void> => {
      while (!this.stopping) {
        try {
          if (this.inFlight.size >= this.concurrency) {
            await sleep(AT_CAPACITY_SLEEP_MS);
            continue;
          }
          const claimedAny = await this.claimAndRun();
          if (!claimedAny && this.inFlight.size === 0) {
            this.idleTicks++;
            if (this.idleTicks >= MAINTENANCE_TICKS) {
              this.idleTicks = 0;
              void maintainBareClones().catch((err) => {
                console.error(
                  '[runner] bare-clone maintenance failed:',
                  err instanceof Error ? err.message : err,
                );
              });
            }
          } else {
            this.idleTicks = 0;
          }
        } catch (err) {
          console.error('[runner] claim tick failed:', err instanceof Error ? err.message : err);
          if (err instanceof Error && err.message.includes('(401)')) {
            await this.shutdown('auth-error');
            return;
          }
          // Back off briefly on unexpected errors so we don't hot-spin if the
          // SaaS is returning 5xx.
          await sleep(this.pollMs);
        }
      }
    };
    // Top-level safety net: if the pump loop ever rejects (e.g. an exception
    // thrown outside its inner try, or a sleep rejection after an AbortSignal
    // refactor), `void pump()` would discard the rejection and leave the
    // daemon alive-but-dead. Catch it here and shut down cleanly so the
    // heartbeat goes `offline` and the SaaS stops dispatching to us.
    void pump().catch((err) => {
      console.error(
        '[runner] pump loop crashed — shutting down:',
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      return this.shutdown('pump-crash');
    });

    // Keep the process alive until shutdown resolves.
    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private resolveExit: (() => void) | null = null;

  private async claimAndRun(): Promise<boolean> {
    let claimedAny = false;
    while (this.inFlight.size < this.concurrency && !this.stopping) {
      // Long-poll for the first attempt too: the route does a single
      // claim_next_job_for_runner immediately, so an already-queued job comes
      // back fast; only the no-work case blocks on LISTEN/NOTIFY. After a
      // successful claim we loop right back in case a backlog exists — the
      // next call may again be immediate (short-circuit) or blocking.
      const claimed = await this.client.claimJob(this.cfg.backends, { wait: LONG_POLL_WAIT_SEC });
      if (!claimed) return claimedAny;
      this.runJob(claimed);
      claimedAny = true;
    }
    return claimedAny;
  }

  private runJob(claimed: ClaimedJob): void {
    const entry: InFlight = {
      jobId: claimed.job.id,
      workflowRunId: claimed.workflowRunId,
      pause: false,
      cancel: false,
      leaseLost: false,
      done: Promise.resolve(),
    };
    this.inFlight.set(claimed.job.id, entry);

    // Phase 4 (migration 0026) — inherit-host substitution. The central
    // returns no token for inherit-host runs (`ghIdentitySource === 'host'`);
    // swap in our cached host token before handing the claim downstream.
    // For any other identity source we pass through whatever the central minted.
    const idSource = claimed.ghIdentitySource ?? 'workspace';
    if (idSource === 'host') {
      if (!this.hostGithubToken) {
        // Should not happen — we hard-fail at startup if inherit-host is on
        // and no token is reachable. Belt-and-braces: refuse the claim
        // cleanly so the watchdog re-queues it for another runner.
        console.error(
          `[runner] job ${claimed.job.id} requires host GH token but none cached; aborting`,
        );
        entry.cancel = true;
      } else {
        claimed.githubToken = this.hostGithubToken;
      }
    }
    console.log(
      `[runner] running job ${claimed.job.id} (${claimed.job.kind} #${claimed.job.issueNumber ?? '?'}) — identity=${idSource}`,
    );
    entry.done = executeJobLocally(
      this.client,
      claimed,
      {
        shouldPause: () => entry.pause, // shutdown does NOT pause — in-flight jobs run to completion
        // A lost lease is treated like a cancel: the SaaS has already re-queued
        // the job (or it's about to), so we abort to avoid double-execution
        // when another runner picks it up.
        shouldCancel: () => entry.cancel || entry.leaseLost,
      },
      {
        // Phase 5 — stamp this runner's UUID on `step-start` events so the
        // central populates `agent_runs.runner_id`. Null on the first claim
        // before the heartbeat reply has echoed our id back; the column then
        // stays NULL for those rows (no attribution, no error).
        runnerId: this.runnerId,
      },
    )
      .catch((err) => {
        console.error(
          `[runner] job ${claimed.job.id} crashed:`,
          redactToken(err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => {
        this.inFlight.delete(claimed.job.id);
        console.log(`[runner] job ${claimed.job.id} finished (${this.inFlight.size} in flight)`);
      });
  }

  /**
   * Phase 4 — re-read the host GH token. Called every 30 min by the
   * `hostTokenTimer` so an expired/rotated token doesn't strand a job.
   * Never overwrites the cached token with null — if the refresh fails we
   * keep the previous value (the existing token may still be valid).
   */
  private async refreshHostGithubToken(): Promise<void> {
    try {
      const next = await readHostGithubToken();
      if (next && next !== this.hostGithubToken) {
        this.hostGithubToken = next;
        console.log('[runner] inherit-host-github: refreshed host GitHub token');
      }
    } catch (err) {
      console.error(
        '[runner] host GitHub token refresh failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Phase 5 — snapshot of current load. Cheap (sync `os` calls + a Map size
   *  read); we sample right before the heartbeat POST so the timestamp on
   *  the central matches the values in the snapshot. */
  private buildUtilization(): RunnerUtilizationPayload {
    return {
      inflight: this.inFlight.size,
      capacity: this.concurrency,
      cpuLoad: os.loadavg()[0],
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      nodeVersion: process.versions.node,
      uptimeSec: Math.round(process.uptime()),
      capturedAt: new Date().toISOString(),
    };
  }

  private async heartbeat(status: 'online' | 'draining' | 'offline'): Promise<void> {
    const inflight = [...this.inFlight.keys()];
    try {
      const reply = await this.client.heartbeat({
        status,
        inflightJobIds: inflight,
        // Keep `currentJobIds` populated for SaaS deployments that haven't
        // taken the 0025 heartbeat update yet.
        currentJobIds: inflight,
        // Phase 4 (migration 0026) — self-describe GitHub identity. Older
        // SaaS deployments ignore these fields entirely.
        githubInheritHost: this.cfg.githubInheritHost ?? false,
        githubInstallationId: this.cfg.githubInheritHost
          ? null
          : (this.cfg.githubInstallationId ?? null),
        // Phase 5 (migration 0027) — load snapshot written verbatim to
        // `runners.utilization`. Cheap; ~200 bytes on the wire.
        utilization: this.buildUtilization(),
      });
      // Phase 5 — cache the runner's own UUID for stamping on step events.
      // Older SaaS deployments omit `runnerId`; we stay backward-compatible
      // by leaving `this.runnerId` null (the column then stays NULL too).
      if (reply.runnerId && reply.runnerId !== this.runnerId) {
        this.runnerId = reply.runnerId;
      }
      for (const jobId of reply.cancelJobIds ?? []) {
        const e = this.inFlight.get(jobId);
        if (e && !e.cancel) {
          e.cancel = true;
          console.log(`[runner] cancel requested for job ${jobId}`);
        }
      }
      for (const runId of reply.pauseRunIds ?? []) {
        for (const e of this.inFlight.values()) {
          if (e.workflowRunId === runId && !e.pause) {
            e.pause = true;
            console.log(`[runner] pause requested for run ${runId}`);
          }
        }
      }
      // Phase 3 lease accounting. An older SaaS omits `renewedJobIds` entirely
      // (undefined) — treat that as "all renewed" so we stay compatible. A
      // newer SaaS returns the subset it actually renewed; everything missing
      // means the watchdog has reclaimed the job and we must abort.
      if (inflight.length > 0 && reply.renewedJobIds !== undefined) {
        const renewed = new Set(reply.renewedJobIds);
        for (const jobId of inflight) {
          if (renewed.has(jobId)) continue;
          const e = this.inFlight.get(jobId);
          if (e && !e.leaseLost) {
            e.leaseLost = true;
            console.warn(
              `[runner] lost lease for job ${jobId} — aborting (likely watchdog reclaim)`,
            );
          }
        }
      }
    } catch (err) {
      console.error('[runner] heartbeat failed:', err instanceof Error ? err.message : err);
      if (err instanceof Error && err.message.includes('(401)')) await this.shutdown('auth-error');
    }
  }

  private async shutdown(why: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    console.log(`[runner] shutting down (${why}) — ${this.inFlight.size} job(s) in flight`);
    // The pump loop drains via its `while (!this.stopping)` guard — no
    // dedicated timer to cancel anymore.
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.hostTokenTimer) clearInterval(this.hostTokenTimer);
    await this.heartbeat('draining').catch(() => {});

    // Grace period for in-flight jobs.
    const GRACE_MS = 5 * 60_000;
    const pending = [...this.inFlight.values()].map((e) => e.done);
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, GRACE_MS))]);
    if (this.inFlight.size > 0) {
      console.warn(
        `[runner] ${this.inFlight.size} job(s) still running at grace timeout — leaving them for the watchdog`,
      );
    }
    await this.heartbeat('offline').catch(() => {});
    this.resolveExit?.();
    // Give the final heartbeat a beat to flush, then exit.
    setTimeout(() => process.exit(0), 250);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reads a GitHub token from the host (inherit-host mode). Preference order:
 *   1. `gh auth token` if the `gh` CLI is on PATH and logged in
 *   2. `process.env.GITHUB_TOKEN` as a fallback
 * Returns null if neither yields a non-empty token. Tolerant: a missing `gh`
 * binary, a logged-out gh, or a non-zero exit all silently fall through.
 */
async function readHostGithubToken(): Promise<string | null> {
  // Try `gh auth token` first. ENOENT (no gh on PATH) → fall back.
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // gh missing / logged out / non-zero exit — fall through.
  }
  const env = (process.env.GITHUB_TOKEN ?? '').trim();
  return env.length > 0 ? env : null;
}
