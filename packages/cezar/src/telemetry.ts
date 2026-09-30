/**
 * Anonymous usage telemetry — the ONE module that talks to the telemetry worker.
 *
 * Opt-out: on by default, off with `CEZ_TELEMETRY=0` or `DO_NOT_TRACK=1` (see
 * `telemetryEnabled`). Everything here is
 * fire-and-forget — a 3 s timeout, no retries, never throws, never awaited on a path
 * the user waits for (the one exception is `app_stop`, which `flushTelemetry` bounds).
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

export const DEFAULT_TELEMETRY_URL = 'https://telemetry-worker.patzick.workers.dev';
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
        console.log(`  [telemetry] ${path} → ${res.status} ${await res.text().catch(() => '')}`);
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

type ContextValue = string | number | boolean | null;

export function reportError(
  error: unknown,
  context: Record<string, ContextValue | undefined> = {},
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

    const code = (err as { code?: unknown }).code;
    const flat: Record<string, ContextValue> = {};
    for (const [k, v] of Object.entries(context).slice(0, 50)) {
      if (v === undefined) continue;
      flat[k] = typeof v === 'string' ? scrub(v).slice(0, 1024) : v;
    }
    void post('/track/error', {
      service: SERVICE,
      version,
      platform: platform(),
      occurredAt: new Date().toISOString(),
      error: {
        type,
        message,
        ...(typeof code === 'string' ? { code: code.slice(0, 128) } : {}),
        ...(err.stack ? { stack: scrub(err.stack).slice(0, 16_384) } : {}),
      },
      user: { id: getInstallId() },
      context: flat,
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
