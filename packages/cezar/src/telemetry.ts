/**
 * Usage telemetry — the ONE module that talks to the telemetry worker.
 *
 * Opt-in: nothing leaves the machine until the user said yes (the cockpit's consent bar,
 * Settings → Privacy, or `cezar telemetry enable`), recorded as `telemetry` in
 * `~/.cezar/config.json`. `CEZ_TELEMETRY=0` / `DO_NOT_TRACK=1` block it even then; no env var
 * can grant it. See docs/telemetry.md. Everything here is
 * fire-and-forget — a 3 s timeout, no retries, never throws, never awaited on a path
 * the user waits for (the one exception is `app_stop`, which `flushTelemetry` bounds).
 *
 * Error reports are WIDE EVENTS (https://loggingsucks.com/): one report carries everything known
 * about the process and the failure as flat, queryable `context` fields — the process's own half
 * (`baseContext`), whatever the boot registered (`registerTelemetryContext`: run counts, install
 * kind…) and the caller's specifics — so a report is debuggable without a second search.
 *
 * The only identity is `cezarId`, a random UUIDv7 in `~/.cezar/config.json` (written on the
 * first send after consent, deleted when it is withdrawn), and the user's home directory is
 * scrubbed from every error message and stack.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { cezarHomeDir } from './paths.ts';
import { detectInstallKind } from './self-update/layout.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';

export const DEFAULT_TELEMETRY_URL = 'https://stats.openmercato.cloud';
/** Bump when what is collected changes: a `granted` for an older version counts as never asked. */
export const TELEMETRY_POLICY_VERSION = 1;
/** Development builds (local, worktrees, PR previews) report under this service. */
export const DEV_TELEMETRY_SERVICE = '01a12ad9-3297-793f-b9e5-81d4df2d1216';
/** Public releases ship `dist/telemetry-service.json`, written at release time by
 *  scripts/stamp-telemetry-service.mjs; anything without the stamp is a development build. */
const SERVICE = stampedTelemetryService() ?? DEV_TELEMETRY_SERVICE;

export function stampedTelemetryService(file = join(dirname(fileURLToPath(import.meta.url)), 'telemetry-service.json')): string | undefined {
  try {
    const { service } = JSON.parse(readFileSync(file, 'utf8')) as { service?: unknown };
    return typeof service === 'string' && /^[\w.:@/+-]{1,64}$/.test(service) ? service : undefined;
  } catch {
    return undefined;
  }
}
const TIMEOUT_MS = 3_000;
/** At most one report per minute for the same error (the worker's "don't flood" rule). */
const ERROR_THROTTLE_MS = 60_000;

let version = '0.0.0';
/** The exact build (`0.14.0-nightly.20261007.63`): context on error reports only. */
let fullVersion = '0.0.0';
/** One lookup per `~/.cezar` (keyed, so a `CEZ_HOME` switch never reuses another home's id). */
const cezarIds = new Map<string, Promise<string>>();
const pending = new Set<Promise<unknown>>();
const lastReported = new Map<string, number>();

export type TelemetryConsent = 'unknown' | 'granted' | 'denied';

/** The answer as last read from (or written to) `~/.cezar/config.json`. */
let consent: TelemetryConsent = 'unknown';

/** What stops sending whatever the user answered: `env` — `CEZ_TELEMETRY=0` or `DO_NOT_TRACK=1`;
 *  `automation` — test runners, CI, `CEZ_DRY_RUN=1`, where nobody could have answered (lifted by
 *  `CEZ_TELEMETRY=1`, which still needs consent). */
export function telemetryBlockedBy(): 'env' | 'automation' | null {
  const env = process.env;
  if (env.CEZ_TELEMETRY === '0' || env.DO_NOT_TRACK === '1') return 'env';
  if (env.CEZ_TELEMETRY === '1') return null;
  return env.VITEST || env.NODE_TEST_CONTEXT || env.CI || env.CEZ_DRY_RUN === '1' ? 'automation' : null;
}

export function telemetryEnabled(): boolean {
  return consent === 'granted' && telemetryBlockedBy() === null;
}

export function telemetryConsent(): TelemetryConsent {
  return consent;
}

function consentOf(config: { telemetry?: { consent: 'granted' | 'denied'; policyVersion: number } }): TelemetryConsent {
  const answer = config.telemetry;
  if (!answer) return 'unknown';
  if (answer.consent === 'denied') return 'denied';
  return answer.policyVersion === TELEMETRY_POLICY_VERSION ? 'granted' : 'unknown';
}

/** Re-read the answer — another process (`cezar telemetry disable`) may have changed it. */
export async function loadTelemetryConsent(): Promise<TelemetryConsent> {
  try {
    consent = consentOf(await loadWorkspaceConfig());
  } catch {
    consent = 'unknown';
  }
  syncCrashReporter();
  return consent;
}

/** Record the user's answer. Withdrawing deletes the install id and the daily-ping marker, so a
 *  later yes starts as a new installation. */
export async function setTelemetryConsent(answer: 'granted' | 'denied'): Promise<TelemetryConsent> {
  const written = await mergeWriteWorkspaceConfig((config) => {
    config.telemetry = { consent: answer, policyVersion: TELEMETRY_POLICY_VERSION, decidedAt: new Date().toISOString() };
    if (answer === 'denied') {
      delete config.cezarId;
      delete config.lastActiveOn;
    }
  });
  if (answer === 'denied') {
    cezarIds.clear();
    lastReported.clear();
  }
  consent = consentOf(written);
  syncCrashReporter();
  return consent;
}

/** Sends are queued behind an id lookup; this re-checks the file first, so a withdrawal made by
 *  another process stops the very next send rather than the next restart. */
async function stillGranted(): Promise<boolean> {
  return (await loadTelemetryConsent()) === 'granted' && telemetryBlockedBy() === null;
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

/**
 * The `version` every event carries: the release plus its channel, never the exact build. Nightly
 * and PR builds stamp a new version per build (`0.14.0-nightly.20261007.63`,
 * `0.14.0-pr1322.2590`); sent as-is, every build would be its own row in version charts and
 * every new nightly would reopen resolved errors as "regressed". So:
 *
 *   0.14.0                       → 0.14.0          (stable)
 *   0.14.0-nightly.20261007.63   → 0.14.0-nightly
 *   0.14.0-pr1322.2590           → 0.14.0-pr
 *   0.13.0+cez-207a3912, a checkout, anything else → 0.13.0-dev
 */
export function telemetryVersion(raw: string, checkout = false): string {
  const match = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(raw.trim());
  if (!match) return 'unknown';
  const [, base, pre] = match;
  if (checkout || raw.includes('+')) return `${base}-dev`;
  if (!pre) return base!;
  if (/^nightly(\.|$)/.test(pre)) return `${base}-nightly`;
  if (/^pr\d+/.test(pre)) return `${base}-pr`;
  return `${base}-dev`;
}

/** Set once at boot; every event carries it. A source checkout (`npm run dev`, a worktree) is a
 *  dev build whatever its package.json says. Resolves once the stored answer is known. */
export async function initTelemetry(opts: { version: string }): Promise<void> {
  fullVersion = opts.version;
  version = telemetryVersion(opts.version, detectInstallKind(process.argv[1] ?? '') === 'checkout');
  refreshProjectRoots();
  await loadTelemetryConsent();
}

let crashReporterWanted = false;
let crashing = false;
function onUncaught(err: Error, origin: string): void {
  if (crashing) process.exit(1);
  crashing = true;
  try {
    console.error(err);
    reportError(err, { source: 'process', handler: origin }, { code: 'uncaught_exception' });
  } catch {
    // the exit below must happen whatever reporting does
  }
  process.exitCode = 1; // a crash never exits 0, even if the loop drains before the flush
  void flushTelemetry(1_000).finally(() => process.exit(1));
}

/** Attach or detach the handler to match the current answer — a no-op until `installCrashReporter`. */
function syncCrashReporter(): void {
  const attached = process.listeners('uncaughtException').includes(onUncaught);
  const want = crashReporterWanted && telemetryEnabled();
  if (want && !attached) process.on('uncaughtException', onUncaught);
  if (!want && attached) process.off('uncaughtException', onUncaught);
}

/** Crash reporting. Node exits synchronously after an uncaught exception, before an async send
 *  can start, so the report needs a real handler: print as Node would, report, flush (bounded),
 *  exit 1. Attached only while telemetry is on, leaving Node's own crash path untouched
 *  otherwise; it follows consent given or withdrawn later in the process's life. */
export function installCrashReporter(): void {
  crashReporterWanted = true;
  syncCrashReporter();
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
  inFlight(
    stillGranted().then((ok) =>
      ok ? cezarId().then((id) => post(`/track/${event}`, { ...body, indexKey: statsKey(id, opts.sid) })) : false,
    ),
  );
}

/** The fields every event carries, for `cezar telemetry inspect` — the same object `track` builds. */
export function telemetryEnvelope(): Record<string, string> {
  return { service: SERVICE, version, platform: platform(), runtime: telemetryRuntime() };
}

/** What is sent, by name: kept beside the senders so `inspect` and docs/telemetry.md can't drift
 *  far from them. */
export const TELEMETRY_EVENTS = [
  'cezar_run', 'app_start', 'app_stop', 'task_start', 'page_viewed', 'message_sent', 'open_in',
  'project_added', 'diff_comment_added', 'task_archived', 'task_unarchived', 'task_pinned',
  'task_unpinned', 'task_deleted', 'error',
] as const;

/** Once per UTC day while telemetry is on: `cezar_run`. Without consent: nothing at all. */
export async function sendDailyPing(): Promise<void> {
  if (!(await stillGranted())) return;
  const today = new Date().toISOString().slice(0, 10);
  if ((await loadWorkspaceConfig()).lastActiveOn === today) return;
  const base = { service: SERVICE, version, platform: platform(), runtime: telemetryRuntime() };
  const ok = await post('/track/cezar_run', { ...base, indexKey: await cezarId() });
  if (ok) {
    await mergeWriteWorkspaceConfig((config) => {
      config.lastActiveOn = today;
    }).catch(() => undefined);
  }
}

/** The daily ping at boot, then hourly so a cockpit left running crosses midnight — and picks
 *  up a consent given meanwhile by another process. */
export function startDailyPing(): void {
  void sendDailyPing();
  setInterval(() => void sendDailyPing(), 60 * 60 * 1000).unref();
}

/** Registered project roots, refreshed off the hot path: `reportError` is synchronous. */
let projectRoots: string[] = [];
function refreshProjectRoots(): void {
  void loadWorkspaceConfig()
    .then((config) => {
      projectRoots = (config.projects ?? []).map((p) => p.root).filter((root): root is string => typeof root === 'string');
    })
    .catch(() => undefined);
}

/** `process.cwd()` throws once the directory is deleted; a report must survive that. */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

/** Replace every path that names the user or their work: project roots and the working directory
 *  become `<repo>`, the temp dir `<tmp>`, the home directory `~` — longest first, so a repo under
 *  home is `<repo>`, not `~/code/<name>`. */
export function scrub(text: string): string {
  const pairs: Array<[string, string]> = [
    ...projectRoots.map((root): [string, string] => [root, '<repo>']),
    [safeCwd(), '<repo>'],
    [tmpdir(), '<tmp>'],
    [homedir(), '~'],
  ];
  return pairs
    .filter(([path]) => path.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((out, [path, mask]) => out.split(path).join(mask), text);
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
    'build.version_full': fullVersion,
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
    refreshProjectRoots(); // a project added since boot is masked from the next report on

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
    inFlight(stillGranted().then((ok) => ok && cezarId().then((id) => post('/track/error', {
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
    }))));
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
