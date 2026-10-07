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
 * Anonymous: the only identity is `cezarId`, a random UUIDv7 in `~/.cezar/config.json`
 * (written, never required — a read-only home falls back to a per-process id), and
 * the user's home directory is scrubbed from every error message and stack.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { cezarHomeDir } from './paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';

// TEMPORARY (local ingest testing): restore 'https://telemetry-ingest.patzick.workers.dev' before shipping.
export const DEFAULT_TELEMETRY_URL = 'http://localhost:8787';
const SERVICE = 'cezar';
const TIMEOUT_MS = 3_000;
/** At most one report per minute for the same error (the worker's "don't flood" rule). */
const ERROR_THROTTLE_MS = 60_000;

let version = '0.0.0';
/** One lookup per `~/.cezar` (keyed, so a `CEZ_HOME` switch never reuses another home's id). */
const cezarIds = new Map<string, Promise<string>>();
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

/** How this cezar was launched — the worker's `runtime` field on every event and report: `app`
 *  when the Tauri desktop shell spawned it (the shell sets `CEZ_DESKTOP=1` on its sidecar), `cli`
 *  for every npm/npx/terminal launch. A browser tab against the desktop's server is still `app`:
 *  this names the process, the page's own surface is `client.surface` on error reports. */
export function telemetryRuntime(): 'app' | 'cli' {
  return process.env.CEZ_DESKTOP === '1' ? 'app' : 'cli';
}

/** Set once at boot; every event carries it. */
export function initTelemetry(opts: { version: string }): void {
  version = opts.version;
}

/** RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, then random bits — sortable by creation time. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** This machine's `cezarId`, created on first use. The merge-write keeps an id another process
 *  wrote first; a read-only home degrades to a per-process id. */
function cezarId(): Promise<string> {
  const home = cezarHomeDir();
  const cached = cezarIds.get(home);
  if (cached) return cached;
  const lookup = (async () => {
    const fresh = uuidv7();
    try {
      const written = await mergeWriteWorkspaceConfig((config) => {
        config.cezarId ??= fresh;
      });
      return written.cezarId ?? fresh;
    } catch {
      return fresh;
    }
  })();
  cezarIds.set(home, lookup);
  return lookup;
}

/** Track a send (including the id lookup before it) so `flushTelemetry` can wait for it. */
function inFlight(p: Promise<unknown>): void {
  const tracked = p.catch(() => undefined).finally(() => pending.delete(tracked));
  pending.add(tracked);
}

function post(path: string, body: Record<string, unknown>): Promise<boolean> {
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
      return res.ok;
    })
    .catch((err: unknown) => {
      if (process.env.CEZ_TELEMETRY_DEBUG === '1') console.log(`  [telemetry] ${path} failed: ${String(err)}`);
      return false;
    })
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

/** One metric event. `extra` rides along for breakdowns the worker may or may not keep. */
/** A cockpit device id (`cezar:sid` in the browser's localStorage): a UUIDv7, or nothing. */
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The header the cockpit sends its device id in; anything that is not a v7 UUID is ignored. */
export function deviceSid(header: string | undefined | null): string | undefined {
  return header && SID_RE.test(header) ? header.toLowerCase() : undefined;
}

/** `indexKey` / `user.id`: `<cezarId>:<sid>` for something a cockpit device did, the bare
 *  `cezarId` for the process itself (boot, stop, daily ping, server errors). */
function statsKey(id: string, sid: string | undefined): string {
  return sid ? `${id}:${sid}` : id;
}

export function track(
  event: string,
  extra: Record<string, string | number | boolean | undefined> = {},
  opts: { sid?: string } = {},
): void {
  if (!telemetryEnabled()) return;
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(event)) return;
  const body: Record<string, unknown> = { service: SERVICE, version, platform: platform(), runtime: telemetryRuntime(), ...extra };
  // The worker's `label` charset; anything else (a model's `[1m]`) would 400 the event.
  if (typeof body.label === 'string') body.label = body.label.replace(/[^\w .:@/+-]/g, '_').slice(0, 64);
  inFlight(cezarId().then((id) => post(`/track/${event}`, { ...body, indexKey: statsKey(id, opts.sid) })));
}

/** Once per UTC day: `cezar_run`, or `telemetry_opt_out` (no id) when opted out. */
export async function sendDailyPing(): Promise<void> {
  const env = process.env;
  const optedOut = env.CEZ_TELEMETRY === '0' || env.DO_NOT_TRACK === '1';
  const quiet = env.CEZ_TELEMETRY !== '1' && Boolean(env.VITEST || env.NODE_TEST_CONTEXT || env.CI || env.CEZ_DRY_RUN === '1');
  if (quiet) return;
  const today = new Date().toISOString().slice(0, 10);
  if ((await loadWorkspaceConfig()).lastActiveOn === today) return;
  const base = { service: SERVICE, version, platform: platform(), runtime: telemetryRuntime() };
  const ok = optedOut
    ? await post('/track/telemetry_opt_out', base)
    : await post('/track/cezar_run', { ...base, indexKey: await cezarId() });
  if (ok) {
    await mergeWriteWorkspaceConfig((config) => {
      config.lastActiveOn = today;
    }).catch(() => undefined);
  }
}

/** The daily ping at boot, then hourly so a cockpit left running crosses midnight. */
export function startDailyPing(): void {
  void sendDailyPing();
  setInterval(() => void sendDailyPing(), 60 * 60 * 1000).unref();
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
  opts: { code?: string; fingerprint?: string; sid?: string } = {},
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
    const occurredAt = new Date().toISOString();
    inFlight(cezarId().then((id) => post('/track/error', {
      service: SERVICE,
      version,
      platform: platform(),
      runtime: telemetryRuntime(),
      occurredAt,
      error: {
        type,
        message,
        ...(code ? { code: code.slice(0, 128) } : {}),
        ...(err.stack ? { stack: scrub(err.stack).slice(0, 16_384) } : {}),
      },
      user: { id: statsKey(id, opts.sid) },
      featureFlags: featureFlags(),
      context: flat,
      ...(opts.fingerprint ? { fingerprint: opts.fingerprint.slice(0, 128) } : {}),
    })));
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
