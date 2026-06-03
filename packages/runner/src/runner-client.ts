import type { Config, Store, CiFollowupInput, FlowStep, WorkspaceLabel } from '@cezar/core';

// ─── wire shapes ────────────────────────────────────────────────────────
// What `GET /api/runner/jobs` returns when there's work. The SaaS has already
// created the `workflow_runs` row (so the runner only POSTs events / PATCHes
// the final state) and minted a short-lived GitHub token.
export interface ClaimedJob {
  job: {
    id: string;
    workspaceId: string;
    repo: string | null;
    kind: 'triage' | 'autofix' | 'ci-followup' | 'flow';
    issueNumber: number | null;
    prNumber: number | null;
    requiredBackend: string | null;
  };
  workflowRunId: string;
  workspace: { id: string; owner: string; repo: string };
  /** Merged workspace config (cosmiconfig defaults + workspace overrides), minus
   * secrets EXCEPT `github.token`, which the runner needs to clone/comment. */
  config: Config;
  /** Short-lived GitHub token minted by the SaaS for this claim. Null for
   *  inherit-host runners (`ghIdentitySource === 'host'`) — the daemon
   *  substitutes its own host-minted token before executing the job. */
  githubToken: string | null;
  /**
   * Phase 4 (migration 0026) — which identity served this claim:
   *   - `'host'`                       → runner mints from `gh auth token` /
   *                                      GITHUB_TOKEN locally.
   *   - `'runner-install:<id>'`        → central minted against the runner's
   *                                      per-runner App install.
   *   - `'workspace:<workspaceId>'`    → central minted via workspace install
   *                                      / admin token (today's default).
   * Older SaaS deployments omit this — treat undefined as workspace-default
   * for logging purposes; behavior is unchanged because the runner only
   * substitutes when the value is exactly `'host'`.
   */
  ghIdentitySource?: string;
  /** Full issue-store snapshot (`IssueStore.getAllData()`) for the workspace. */
  store: Store;
  /** For `ci-followup` jobs only — lifted off `jobs.payload.ciFollowup`. */
  ciFollowupSeed: CiFollowupInput | null;
  /** For `flow` jobs only — the `flows` row referenced by `jobs.payload.flowId`. */
  flow: { name: string; steps: FlowStep[]; input: string } | null;
  /**
   * Workspace label catalog (the accepted `workspace_labels` rows for this
   * workspace). The runner forwards these into the engine so each agent step
   * gets the catalog injected into its system prompt — same behavior as the
   * cron-based dispatcher. Missing (older SaaS) ⇒ runner falls back to no
   * catalog, which the engine treats as a no-op.
   */
  labels?: WorkspaceLabel[];
  /**
   * Phase 2 re-claim resume. Set when the SaaS is handing back an existing
   * `workflow_runs` row (the watchdog re-queued a crashed job). The runner
   * threads this into the engine which spawns `claude --resume <id>` for
   * the first agent step. Cross-host re-claims fall back to a fresh start
   * under the same id (the on-disk session blob isn't local).
   */
  resumeSessionId?: string | null;
}

/** One streamed event the runner POSTs back to `/api/runner/runs/:id/events`. */
export interface RunnerEvent {
  type: 'lifecycle' | 'agent-text' | 'tool-call' | 'tool-result' | 'note' | 'step-start' | 'step-end';
  payload: unknown;
  /** Step lifecycle (`step-start`/`step-end`) carries these so the SaaS can
   * upsert an `agent_runs` row + advance `workflow_runs.current_step_id`. */
  stepId?: string;
  iteration?: number;
  kind?: string;
  backend?: string | null;
  model?: string | null;
  status?: string;
  summary?: string | null;
  error?: string | null;
  tokensUsed?: number;
  startedAt?: string;
  finishedAt?: string | null;
  /** Claude CLI session id this step ran under. Plumbed into the
   *  `ingest_runner_events` RPC so it can populate `agent_runs.session_id`
   *  and seed `workflow_runs.session_id` (migration 0024). Lets a re-claim
   *  after a runner crash resume via `claude --resume <id>`. */
  sessionId?: string;
  /** Phase 5 (migration 0027) — runner UUID stamped on step events so the
   *  central can populate `agent_runs.runner_id` (first-writer-wins via the
   *  RPC's coalesce). Omitted (or empty) on cron-dispatched runs. */
  runnerId?: string;
}

export interface FinalizeRunBody {
  status: 'succeeded' | 'failed' | 'paused' | 'cancelled' | 'dry-run' | 'pr-opened' | 'pushed' | 'skipped';
  outcome?: unknown;
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  headSha?: string | null;
  tokensUsed?: number;
  reason?: string | null;
  /** Claude CLI session id for the whole run (migration 0024). Stamped on
   *  `workflow_runs.session_id` so a future re-claim can `claude --resume <id>`. */
  sessionId?: string | null;
}

export interface HeartbeatBody {
  status?: 'online' | 'draining' | 'offline';
  /** Legacy alias for `inflightJobIds` — kept for older SaaS deployments. */
  currentJobIds?: string[];
  /** Phase 3: ids of jobs the runner currently has in flight. The SaaS uses
   *  this to renew leases (migration 0025) and reports back which ids were
   *  actually renewed via {@link HeartbeatReply.renewedJobIds}. */
  inflightJobIds?: string[];
  /** Phase 4 (migration 0026) — runner advertises that it mints its own
   *  GitHub token locally from `gh auth token` / GITHUB_TOKEN. The SaaS
   *  upserts this onto `runners.github_inherit_host` so admins can see the
   *  mode in the cockpit without manual config. Precedence: when true,
   *  `githubInstallationId` is ignored server-side. */
  githubInheritHost?: boolean;
  /** Phase 4 (migration 0026) — runner advertises its per-runner GitHub App
   *  install id. The SaaS upserts onto `runners.github_installation_id` so
   *  subsequent claims mint against this install. NULL clears it. */
  githubInstallationId?: number | null;
  /** Phase 5 (migration 0027) — runner-reported load snapshot. Written
   *  verbatim onto `runners.utilization` JSONB by the heartbeat route so the
   *  cockpit `/cockpit/runners` page can show inflight / capacity / load /
   *  free-mem at a glance. Older SaaS deployments ignore the field. */
  utilization?: RunnerUtilizationPayload;
}

/**
 * Phase 5 — load snapshot shape. Mirrors `RunnerUtilization` in the GUI
 * `lib/supabase/types.ts` (kept duplicated so the runner doesn't import GUI
 * code). All sizes in MB; `cpuLoad` is the 1-minute load average; `uptimeSec`
 * is the runner process's uptime; `capturedAt` is an ISO timestamp recorded
 * right before the heartbeat POST.
 */
export interface RunnerUtilizationPayload {
  inflight: number;
  capacity: number;
  cpuLoad: number;
  freeMemMb: number;
  totalMemMb: number;
  nodeVersion: string;
  uptimeSec: number;
  capturedAt: string;
}

export interface HeartbeatReply {
  ok: true;
  /** Jobs this runner holds whose row was marked `cancelled` — abort them. */
  cancelJobIds: string[];
  /** Workflow runs this runner is driving whose `pause_requested` is set. */
  pauseRunIds: string[];
  /** Phase 3: subset of `inflightJobIds` whose leases the SaaS actually
   *  renewed. Anything sent that isn't here means the runner has lost the
   *  claim (watchdog reclaim, cancel, etc.) and should abort that job.
   *  Older SaaS deployments omit this — treat the missing field as "all
   *  renewed" so the runner stays backward-compatible. */
  renewedJobIds?: string[];
  /** Phase 5 (migration 0027) — the central echoes the runner's own UUID
   *  back on every heartbeat reply so the daemon can stamp `runnerId` on
   *  `step-start` events without an extra round-trip. Older SaaS deployments
   *  omit this and the daemon falls back to not stamping (the column stays
   *  NULL, which the cockpit handles as "no runner attribution"). */
  runnerId?: string;
}

// ─── client ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 4;

/** Thin bearer-authed HTTP client for the SaaS runner API. Retries 5xx/network
 * with exponential backoff; throws hard on 401 (bad/revoked token). */
export class RunnerClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {
    // Refuse to send the long-lived runner bearer token over a non-TLS
    // transport. A prod typo (`http://…`) or a local-dev URL pasted into a
    // deployment would otherwise leak the credential in plaintext on every
    // claim/heartbeat/finalize call. Localhost stays painless; opt out with
    // CEZAR_RUNNER_ALLOW_INSECURE=1 for non-localhost dev setups.
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`cezar-runner: invalid --url / CEZAR_RUNNER_URL: '${baseUrl}'`);
    }
    const isLoopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1';
    const allowInsecure = process.env.CEZAR_RUNNER_ALLOW_INSECURE === '1';
    if (parsed.protocol !== 'https:' && !isLoopback && !allowInsecure) {
      throw new Error(
        `cezar-runner: refusing to send the runner token over ${parsed.protocol} ` +
          `(${parsed.host}). Use an https:// URL, or set CEZAR_RUNNER_ALLOW_INSECURE=1 for local dev.`,
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async claimJob(backends: string[], opts: { wait?: number } = {}): Promise<ClaimedJob | null> {
    const params = new URLSearchParams();
    if (backends.length) params.set('backends', backends.join(','));
    // `wait` is clamped server-side; we pass it as-is. 0 (default) preserves
    // the legacy short-poll behavior so the CLI's one-shot caller is unaffected.
    if (opts.wait && opts.wait > 0) params.set('wait', String(opts.wait));
    const qs = params.toString();
    // Allow the long-poll response to outlive the wait window by a few seconds
    // so a hit on the last beat of the window still lands. Short-poll callers
    // get the default `request` timeout.
    const timeoutMs = opts.wait && opts.wait > 0 ? (opts.wait + 5) * 1000 : undefined;
    try {
      const body = await this.request<{ job: null } | ClaimedJob>('GET', `/api/runner/jobs${qs ? `?${qs}` : ''}`, undefined, { timeoutMs });
      if (!body || (body as { job: null }).job === null) return null;
      return body as ClaimedJob;
    } catch (err) {
      // AbortError from the long-poll timeout slack expiring is benign — same
      // outcome as "no claim, try again". The caller (daemon) will pump again.
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) return null;
      throw err;
    }
  }

  async postEvents(workflowRunId: string, events: RunnerEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.request('POST', `/api/runner/runs/${workflowRunId}/events`, { events });
  }

  async finalizeRun(workflowRunId: string, body: FinalizeRunBody): Promise<void> {
    await this.request('PATCH', `/api/runner/runs/${workflowRunId}`, body);
  }

  async heartbeat(body: HeartbeatBody): Promise<HeartbeatReply> {
    return this.request<HeartbeatReply>('POST', '/api/runner/heartbeat', body);
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Per-call abort so a long-poll fetch doesn't hang forever if the
      // socket goes silent. The route's wait cap is 25s; we add 5s of
      // slack so a hit on the last beat still lands.
      const controller = opts.timeoutMs ? new AbortController() : null;
      const abortTimer = controller && opts.timeoutMs
        ? setTimeout(() => controller.abort(), opts.timeoutMs)
        : null;
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller?.signal,
        });
        if (res.status === 401) throw new Error(`runner token rejected (401) for ${method} ${path}`);
        if (res.status >= 500) throw new RetryableError(`${method} ${path} → ${res.status}`);
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text().catch(() => '')}`);
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (err) {
        lastErr = err;
        // 401 (and other non-retryable) — bail immediately.
        if (err instanceof Error && err.message.includes('(401)')) throw err;
        if (!(err instanceof RetryableError) && !isNetworkError(err)) throw err;
        if (attempt === MAX_RETRIES) break;
        await sleep(250 * 2 ** attempt);
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

class RetryableError extends Error {}

function isNetworkError(err: unknown): boolean {
  // `fetch` throws a TypeError on connection failures / DNS / ECONNREFUSED.
  return err instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
