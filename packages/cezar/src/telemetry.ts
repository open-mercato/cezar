/**
 * Anonymous usage telemetry — the ONE module that talks to the telemetry worker.
 *
 * Opt-out: on by default, off with `CEZ_TELEMETRY=0` or `DO_NOT_TRACK=1` (see
 * `telemetryEnabled`). Everything here is
 * fire-and-forget — a 3 s timeout, no retries, never throws, never awaited on a path
 * the user waits for (the one exception is `app_stop`, which `flushTelemetry` bounds).
 *
 * Error reports are WIDE EVENTS (https://loggingsucks.com/): one report carries everything known
 * about the process and the failure as flat, queryable `context` fields — the process's own half
 * (`baseContext`), whatever the boot registered (`registerTelemetryContext`: run counts, install
 * kind…) and the caller's specifics — so a report is debuggable without a second search.
 *
 * Anonymous: the only identity is a random install id in `~/.cezar/telemetry-id`
 * (written, never required — a read-only home falls back to a per-process id), and
 * the user's home directory is scrubbed from every error message and stack.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cezarHomeDir } from './paths.ts';

export const DEFAULT_TELEMETRY_URL = 'https://telemetry-ingest.patzick.workers.dev';
const SERVICE = 'cezar';
const TIMEOUT_MS = 3_000;
/** At most one report per minute for the same error (the worker's "don't flood" rule). */
const ERROR_THROTTLE_MS = 60_000;

let version = '0.0.0';
let installId: string | undefined;
const pending = new Set<Promise<unknown>>();
const lastReported = new Map<string, number>();

/** On by default; `CEZ_TELEMETRY=0` or the `DO_NOT_TRACK=1` convention opts out. Test runners,
 *  CI and `CEZ_DRY_RUN=1` (the e2e suite, demos) don't send unless forced with `CEZ_TELEMETRY=1`. */
export function telemetryEnabled(): boolean {
  const env = process.env;
  if (env.CEZ_TELEMETRY === '0' || env.DO_NOT_TRACK === '1') return false;
  if (env.CEZ_TELEMETRY === '1') return true;
  return !(env.VITEST || env.NODE_TEST_CONTEXT || env.CI || env.CEZ_DRY_RUN === '1');
}

function telemetryUrl(): string {
  return (process.env.CEZ_TELEMETRY_URL || DEFAULT_TELEMETRY_URL).replace(/\/+$/, '');
}

function platform(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

/** Set once at boot; every event carries it. */
export function initTelemetry(opts: { version: string }): void {
  version = opts.version;
}

function getInstallId(): string {
  if (installId) return installId;
  const file = join(cezarHomeDir(), 'telemetry-id');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return (installId = existing);
  } catch {
    // first run — generate below
  }
  installId = randomUUID();
  try {
    mkdirSync(cezarHomeDir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${installId}\n`, { mode: 0o600 });
  } catch {
    // read-only home: a per-process id is still anonymous, just not stable
  }
  return installId;
}

function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const p = fetch(`${telemetryUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then(async (res) => {
      if (process.env.CEZ_TELEMETRY_DEBUG === '1') {
        console.log(`  [telemetry] ${path} → ${res.status} ${await res.text().catch(() => '')}\n    ${JSON.stringify(body)}`);
      }
    })
    .catch((err: unknown) => {
      if (process.env.CEZ_TELEMETRY_DEBUG === '1') console.log(`  [telemetry] ${path} failed: ${String(err)}`);
    })
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

/** One metric event. `extra` rides along for breakdowns the worker may or may not keep. */
export function track(event: string, extra: Record<string, string | number | boolean | undefined> = {}): void {
  if (!telemetryEnabled()) return;
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(event)) return;
  void post(`/track/${event}`, {
    service: SERVICE,
    version,
    platform: platform(),
    indexKey: getInstallId(),
    ...extra,
  });
}

/** Replace the home directory (it carries the OS username) with `~`. */
function scrub(text: string): string {
  const home = homedir();
  return home ? text.split(home).join('~') : text;
}

export type ContextValue = string | number | boolean | null;
type Context = Record<string, ContextValue | undefined>;

/** The worker's cap on `context` keys. */
const MAX_CONTEXT_KEYS = 50;
const providers: Array<() => Context> = [];

/** Add a slice every error report carries (evaluated per report, so it is always current). A
 *  provider that throws is skipped — context must never cost the report. */
export function registerTelemetryContext(provider: () => Context): void {
  providers.push(provider);
}

function flag(name: string): boolean {
  return process.env[name] === '1';
}

/** The process's own half of every wide event: what build, on what surface, how long up, how
 *  loaded. Low-cost reads only. */
function baseContext(): Context {
  const mem = process.memoryUsage();
  return {
    'app.surface': flag('CEZ_DESKTOP') ? 'desktop' : 'cli',
    'app.supervised': flag('CEZ_SUPERVISED'),
    'app.remote': flag('CEZ_REMOTE'),
    'app.dry_run': flag('CEZ_DRY_RUN'),
    'process.uptime_s': Math.round(process.uptime()),
    'process.rss_mb': Math.round(mem.rss / 1_048_576),
    'process.heap_used_mb': Math.round(mem.heapUsed / 1_048_576),
    'runtime.node': process.versions.node,
    'runtime.arch': process.arch,
  };
}

/** Flags that change behavior, as the worker's `featureFlags` (booleans only). Defaults mirror
 *  each flag's own: default-on features are on unless set to 0. */
function featureFlags(): Record<string, boolean> {
  const env = process.env;
  return {
    dispatch: env.CEZ_DISPATCH !== '0',
    automations: env.CEZ_AUTOMATIONS !== '0',
    followups: env.CEZ_FOLLOWUPS === '1',
    skills_auto_update: env.CEZ_SKILLS_AUTO_UPDATE !== '0',
    approval_gate: env.CEZ_APPROVAL_GATE === '1',
  };
}

export function reportError(
  error: unknown,
  context: Context = {},
  opts: { code?: string; fingerprint?: string } = {},
): void {
  if (!telemetryEnabled()) return;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const type = (err.name || 'Error').slice(0, 128);
    const message = scrub(err.message || String(error)).slice(0, 2048);
    const key = `${type}:${message}`;
    const now = Date.now();
    if (now - (lastReported.get(key) ?? 0) < ERROR_THROTTLE_MS) return;
    lastReported.set(key, now);

    const errCode = (err as { code?: unknown }).code;
    const code = opts.code ?? (typeof errCode === 'string' ? errCode : undefined);
    // The caller's specifics first: when the cap bites, the generic slices are what gets cut.
    const flat: Record<string, ContextValue> = {};
    const slices: Context[] = [context];
    for (const provider of providers) {
      try {
        slices.push(provider());
      } catch {
        // a broken provider costs its own slice, never the report
      }
    }
    slices.push(baseContext());
    for (const slice of slices) {
      for (const [k, v] of Object.entries(slice)) {
        if (v === undefined || k in flat) continue;
        if (Object.keys(flat).length >= MAX_CONTEXT_KEYS) break;
        flat[k] = typeof v === 'string' ? scrub(v).slice(0, 1024) : v;
      }
    }
    void post('/track/error', {
      service: SERVICE,
      version,
      platform: platform(),
      occurredAt: new Date().toISOString(),
      error: {
        type,
        message,
        ...(code ? { code: code.slice(0, 128) } : {}),
        ...(err.stack ? { stack: scrub(err.stack).slice(0, 16_384) } : {}),
      },
      user: { id: getInstallId() },
      featureFlags: featureFlags(),
      context: flat,
      ...(opts.fingerprint ? { fingerprint: opts.fingerprint.slice(0, 128) } : {}),
    });
  } catch {
    // reporting must never throw
  }
}

/** Wait (bounded) for in-flight sends — used at shutdown so `app_stop` gets out. */
export async function flushTelemetry(maxMs = 1_500): Promise<void> {
  if (pending.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => setTimeout(resolve, maxMs).unref()),
  ]);
}
