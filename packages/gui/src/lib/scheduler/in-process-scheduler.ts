// In-process scheduler — the sole cron driver. Drives every cron route on
// `setInterval` from inside the Next.js server process (the Vercel `vercel.json`
// schedules were removed; this replaces them everywhere).
//
// Booted by `src/instrumentation.ts` on the Node.js runtime — on by default
// when `CRON_SECRET` is set, with `CEZAR_INPROCESS_CRON` as the force-on/off
// override (see that file). Idempotent via a `globalThis` flag so dev-mode HMR
// reloads don't spawn duplicate timers. In multi-replica deployments every
// replica ticks — that's safe (the cron handlers all dedupe / atomically claim)
// just wasteful; disable extras with `CEZAR_INPROCESS_CRON=false` or pare them
// back with `CEZAR_INPROCESS_CRON_DISABLED`.
//
// Implementation note: this driver `fetch`es the local cron routes rather than
// importing their handler modules. That keeps `@cezar/core` (and its
// `cosmiconfig` → Node-builtins transitive deps) out of the bundle Next.js
// generates for the Edge-runtime build of `instrumentation.ts`. The cron
// routes themselves run on the Node runtime, so the actual work happens in
// the same process — the `fetch` is a localhost round-trip.

const FLAG = Symbol.for('cezar.inProcessScheduler.started');

interface CronJob {
  /** e.g. '/api/cron/dispatch' */
  path: string;
  /** tick interval in ms */
  defaultIntervalMs: number;
  /** env var that overrides `defaultIntervalMs` */
  envOverride: string;
  /** custom log formatter for the JSON body returned by the route — return null to stay silent on this tick */
  formatLog?: (body: unknown) => string | null;
}

// Cron cadences: dispatch every 60s, triage-sweep every 10 min, sync every 5 min.
const JOBS: CronJob[] = [
  {
    path: '/api/cron/dispatch',
    defaultIntervalMs: 60_000,
    envOverride: 'CEZAR_DISPATCH_INTERVAL_MS',
    formatLog: (b) => {
      const r = b as { claimed?: number; requeued?: number; error?: string };
      if (r.error) return `error: ${r.error}`;
      if ((r.claimed ?? 0) > 0 || (r.requeued ?? 0) > 0)
        return `claimed ${r.claimed ?? 0}, requeued ${r.requeued ?? 0}`;
      return null;
    },
  },
  {
    path: '/api/cron/triage-sweep',
    defaultIntervalMs: 600_000,
    envOverride: 'CEZAR_TRIAGE_SWEEP_INTERVAL_MS',
    formatLog: (b) => {
      const r = b as { enqueued?: number; workspaces?: number; error?: string };
      if (r.error) return `error: ${r.error}`;
      if ((r.enqueued ?? 0) > 0)
        return `enqueued ${r.enqueued} across ${r.workspaces} workspace(s)`;
      return null;
    },
  },
  {
    path: '/api/cron/sync',
    defaultIntervalMs: 300_000,
    envOverride: 'CEZAR_CRON_SYNC_INTERVAL_MS',
    formatLog: (b) => {
      const r = b as { enqueued?: number; workspaces?: number; error?: string };
      if (r.error) return `error: ${r.error}`;
      if ((r.enqueued ?? 0) > 0)
        return `enqueued ${r.enqueued} across ${r.workspaces} workspace(s)`;
      return null;
    },
  },
];

interface SchedulerState {
  intervals: Array<ReturnType<typeof setInterval>>;
  inflight: Map<string, boolean>;
  /** last-tick health per path — used to log failure/recovery transitions once, not every tick */
  failing: Map<string, boolean>;
}

function getState(): SchedulerState {
  const g = globalThis as unknown as Record<symbol, SchedulerState>;
  if (!g[FLAG]) g[FLAG] = { intervals: [], inflight: new Map(), failing: new Map() };
  return g[FLAG];
}

class CronHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly snippet: string,
  ) {
    super(`${path} → ${status}: ${snippet}`);
    this.name = 'CronHttpError';
  }
}

function resolveBaseUrl(): string {
  // The scheduler hits the local cron routes that run in this same process, so
  // a loopback URL is the correct default — prefer it over `NEXT_PUBLIC_APP_URL`
  // (which in a Docker/Traefik deploy points at the external LB, adding a
  // pointless TLS round-trip and risking dropped `Authorization` headers → 401s).
  // `CEZAR_INPROCESS_CRON_BASE_URL` is the explicit escape hatch for the rare
  // reverse-proxy case.
  return (
    process.env.CEZAR_INPROCESS_CRON_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`
  );
}

function disabledPaths(): Set<string> {
  return new Set(
    (process.env.CEZAR_INPROCESS_CRON_DISABLED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function hit(path: string, baseUrl: string, secret?: string): Promise<unknown> {
  const url = baseUrl.replace(/\/$/, '') + path;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new CronHttpError(res.status, path, text.slice(0, 200));
  return body;
}

/** Start the in-process scheduler. Safe to call multiple times. */
export function startInProcessScheduler(): void {
  const state = getState();
  if (state.intervals.length > 0) return;

  const baseUrl = resolveBaseUrl();
  const secret = process.env.CRON_SECRET;
  const disabled = disabledPaths();

  const active = JOBS.filter((j) => !disabled.has(j.path)).map((j) => ({
    job: j,
    intervalMs: Number(process.env[j.envOverride]) || j.defaultIntervalMs,
  }));

  const summary = active.map((a) => `${a.job.path}@${a.intervalMs}ms`).join(', ');
  console.log(
    `[scheduler] starting — base ${baseUrl}; ${active.length} job(s): ${summary || '(none)'}`,
  );

  for (const { job, intervalMs } of active) {
    const tick = async () => {
      if (state.inflight.get(job.path)) return; // skip overlap
      state.inflight.set(job.path, true);
      try {
        const body = await hit(job.path, baseUrl, secret);
        // Recovered: a prior tick was failing, this one succeeded — surface that.
        if (state.failing.get(job.path)) {
          console.log(`[scheduler] ${job.path} — recovered (2xx)`);
          state.failing.set(job.path, false);
        }
        const line = job.formatLog ? job.formatLog(body) : `ok`; // generic: legacy routes return varied shapes — only log when something noteworthy
        if (line !== null && line !== 'ok') console.log(`[scheduler] ${job.path} — ${line}`);
      } catch (err) {
        // Log the first failure of each path prominently (with the status code
        // and, on 401, a CRON_SECRET hint) so a silent 401 storm can't hide in a
        // busy log. Subsequent consecutive failures stay quiet until recovery.
        if (!state.failing.get(job.path)) {
          state.failing.set(job.path, true);
          if (err instanceof CronHttpError) {
            const hint =
              err.status === 401
                ? ' — the cron route rejected the request; check that CRON_SECRET matches the value the route reads'
                : '';
            console.error(
              `[scheduler] ${job.path} failing — HTTP ${err.status}${hint}: ${err.snippet}`,
            );
          } else {
            console.error(
              `[scheduler] ${job.path} failing —`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      } finally {
        state.inflight.set(job.path, false);
      }
    };
    state.intervals.push(setInterval(tick, intervalMs));
  }

  const shutdown = (signal: string) => {
    console.log(`[scheduler] ${signal} — stopping`);
    stopInProcessScheduler();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export function stopInProcessScheduler(): void {
  const state = getState();
  for (const iv of state.intervals) clearInterval(iv);
  state.intervals = [];
  state.inflight.clear();
  state.failing.clear();
}
