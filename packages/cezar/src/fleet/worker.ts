import { cpus, freemem, loadavg, platform } from 'node:os';
import type { FleetHeartbeat, FleetHeartbeatResponse, FleetJob, FleetJobReport } from '@open-mercato/cezar-contract';

/**
 * The per-node worker loop (spec 2026-10-21-fleet-coordination). Every node — the hub included —
 * heartbeats its free capacity and the jobs it holds, runs what comes back, and maps each local run
 * onto a job status. It knows nothing about HTTP or RunManager: the transport and the run host are
 * injected, so the hub runs the same loop in-process and tests drive it with fakes.
 */

export const HEARTBEAT_MS = 5_000;

/** What the worker needs from a node's run machinery (`runs.ts` is the real one). */
export interface FleetRunHost {
  /** Resolve the job's repo to a local project (cloning if needed) and start a run; returns the run id. */
  start(job: FleetJob): Promise<string>;
  /** The run's current state, or undefined when it is gone. */
  get(runId: string): { status: string; branch?: string; error?: string } | undefined;
  cancel(runId: string): void;
  /** Cancel recovered runs of jobs this process does not hold; returns how many. */
  cancelOrphans(): Promise<number>;
  /** Push the run's branch and open a draft PR so the result survives an ephemeral pod. */
  publish(runId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
}

export interface FleetWorkerOptions {
  nodeId: string;
  version: string;
  host: FleetRunHost;
  transport: (heartbeat: FleetHeartbeat) => Promise<FleetHeartbeatResponse>;
  /** The node's own effective capacity. Autoscaled or dynamic local limits show up here and so
   *  steer the whole fleet's distribution. */
  capacity: () => { free: number; max: number };
  intervalMs?: number;
  /** A job older than this is failed and its run cancelled. Unset = no limit (tests). */
  jobTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface Held {
  job: FleetJob;
  runId?: string;
  branch?: string;
  prUrl?: string;
  error?: string;
  status: FleetJobReport['status'];
  publishing: boolean;
  startedAt: number;
  /** Cancelled/dropped by the hub, possibly while `host.start()` was still cloning. */
  released: boolean;
}

/** Run statuses that mean "still working" (autonomous runs never park at `waiting`). */
const LIVE_RUN = new Set(['queued', 'running', 'waiting']);

/** `git push` + `gh pr create` find nothing to propose when the agent changed nothing. */
const NOTHING_TO_PROPOSE = /^nothing to propose/;

export function hostMetrics(): FleetHeartbeat['host'] {
  const cores = cpus().length;
  // loadavg is always 0 on Windows; omit rather than report a false idle.
  const cpuPct = platform() === 'win32' || cores === 0 ? undefined : Math.min(100, Math.round(((loadavg()[0] ?? 0) / cores) * 100));
  return { ...(cpuPct !== undefined ? { cpuPct } : {}), memAvailableBytes: freemem() };
}

export class FleetWorker {
  private readonly held = new Map<string, Held>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = true;
  private lastError = '';

  constructor(private readonly options: FleetWorkerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = (): void => {
      void this.tick().finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(loop, this.options.intervalMs ?? HEARTBEAT_MS);
        this.timer.unref();
      });
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Jobs this node currently holds (tests, status). */
  heldJobIds(): string[] {
    return [...this.held.keys()];
  }

  /** One heartbeat round. Never throws: a hub that is down is retried on the next tick. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.pollRuns();
      const reports = [...this.held.values()].map(report);
      // Jobs handed to us whose run is not created yet, or is queued behind the semaphore, hold no
      // slot, so count them as used or the hub would over-assign.
      const starting = [...this.held.values()].filter(
        (h) => h.status === 'running' && (!h.runId || this.options.host.get(h.runId)?.status === 'queued'),
      ).length;
      const { free, max } = this.options.capacity();
      let response: FleetHeartbeatResponse;
      try {
        response = await this.options.transport({
          nodeId: this.options.nodeId,
          version: this.options.version,
          capacity: { free: Math.max(0, free - starting), max },
          host: hostMetrics(),
          jobs: reports,
        });
        this.lastError = '';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.lastError) this.options.log?.(`fleet: heartbeat failed (${message}); will retry`);
        this.lastError = message;
        return;
      }
      this.apply(response, reports);
    } finally {
      this.ticking = false;
    }
  }

  private apply(response: FleetHeartbeatResponse, sent: FleetJobReport[]): void {
    // The hub has seen the final report of a finished job; only now is it safe to forget it.
    for (const r of sent) if (r.status === 'done' || r.status === 'failed') this.held.delete(r.id);
    for (const id of [...response.cancel, ...response.drop]) this.release(id);
    for (const job of response.assigned) {
      if (this.held.has(job.id)) continue; // redelivered assignment we already acted on
      const held: Held = { job, status: 'running', publishing: false, startedAt: (this.options.now ?? Date.now)(), released: false };
      this.held.set(job.id, held);
      void this.begin(held);
    }
  }

  private async begin(held: Held): Promise<void> {
    try {
      held.runId = await this.options.host.start(held.job);
      // Cancelled while cloning: there was no run to stop then, so stop it now.
      if (held.released) this.options.host.cancel(held.runId);
    } catch (error) {
      held.status = 'failed';
      held.error = error instanceof Error ? error.message : String(error);
    }
  }

  private release(jobId: string): void {
    const held = this.held.get(jobId);
    if (!held) return;
    held.released = true;
    this.held.delete(jobId);
    if (held.runId) this.options.host.cancel(held.runId);
  }

  /** Map each held job's local run onto a job status. */
  private pollRuns(): void {
    for (const held of this.held.values()) {
      if (held.status === 'done' || held.status === 'failed' || held.publishing) continue;
      const limit = this.options.jobTimeoutMs;
      if (limit && (this.options.now ?? Date.now)() - held.startedAt > limit) {
        // A hung or endlessly monitoring run would renew its lease forever.
        held.status = 'failed';
        held.error = `job exceeded the ${Math.round(limit / 60_000)} minute limit (CEZ_FLEET_JOB_TIMEOUT_MINUTES)`;
        held.released = true;
        if (held.runId) this.options.host.cancel(held.runId);
        continue;
      }
      if (!held.runId) continue;
      const run = this.options.host.get(held.runId);
      if (!run) {
        held.status = 'failed';
        held.error = 'run disappeared from the node';
        continue;
      }
      if (run.branch) held.branch = run.branch;
      if (LIVE_RUN.has(run.status)) held.status = 'running';
      else if (run.status === 'done' || run.status === 'review') void this.finish(held);
      else {
        held.status = 'failed';
        held.error = run.error ?? (run.status === 'cancelled' ? 'run was cancelled on the node' : 'run failed');
      }
    }
  }

  private async finish(held: Held): Promise<void> {
    if (!held.job.openPr || !held.runId) {
      held.status = 'done'; // no PR was asked for: the branch stays on this node
      return;
    }
    held.publishing = true;
    held.status = 'review';
    try {
      const result = await this.options.host.publish(held.runId);
      if (result.ok) {
        held.prUrl = result.url;
        held.status = 'done';
      } else if (NOTHING_TO_PROPOSE.test(result.error)) {
        held.status = 'done'; // the agent changed nothing: finished, no PR to open
      } else {
        held.status = 'failed';
        held.error = result.error;
      }
    } catch (error) {
      held.status = 'failed';
      held.error = error instanceof Error ? error.message : String(error);
    }
  }
}

function report(held: Held): FleetJobReport {
  return {
    id: held.job.id,
    status: held.status,
    ...(held.runId ? { runId: held.runId } : {}),
    ...(held.branch ? { branch: held.branch } : {}),
    ...(held.prUrl ? { prUrl: held.prUrl } : {}),
    ...(held.error ? { error: held.error } : {}),
  };
}
