import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  RunnerRegisterResponseSchema,
  type RunnerRegisterRequest,
  type RunnerRegisterResponse,
} from '@cezar/core';
import { assertSecureRunnerUrl } from './runner-client.js';

// ─── persisted credentials ──────────────────────────────────────────────
// The per-runner bearer token returned by /api/runner/register, persisted so
// a restarted daemon (or recreated container with the home volume mounted)
// reuses its identity instead of re-registering every boot.

const CredentialsSchema = z.object({
  /** SaaS base URL these credentials were registered against. */
  url: z.string(),
  runnerId: z.string(),
  token: z.string(),
  registeredAt: z.string(),
});
export type RunnerCredentials = z.infer<typeof CredentialsSchema>;

const CREDENTIALS_FILE = 'credentials.json';

export function defaultStateDir(): string {
  return process.env.CEZAR_RUNNER_STATE_DIR || join(os.homedir(), '.cezar-runner');
}

/**
 * Reads persisted credentials. Returns null when absent, unparseable, or
 * registered against a different SaaS URL (a stale volume pointed at a new
 * deployment must re-register, not present a foreign token).
 */
export async function readCredentials(
  stateDir: string,
  url: string,
): Promise<RunnerCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir, CREDENTIALS_FILE), 'utf8');
  } catch {
    return null;
  }
  let parsed: RunnerCredentials;
  try {
    parsed = CredentialsSchema.parse(JSON.parse(raw));
  } catch {
    console.warn(`[cezar-runner] ignoring malformed ${join(stateDir, CREDENTIALS_FILE)}`);
    return null;
  }
  if (normalizeUrl(parsed.url) !== normalizeUrl(url)) {
    console.warn(
      `[cezar-runner] persisted credentials are for ${parsed.url}, not ${url} — re-registering`,
    );
    return null;
  }
  return parsed;
}

export async function writeCredentials(stateDir: string, creds: RunnerCredentials): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, CREDENTIALS_FILE), `${JSON.stringify(creds, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function clearCredentials(stateDir: string): Promise<void> {
  await rm(join(stateDir, CREDENTIALS_FILE), { force: true });
}

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

// ─── registration ───────────────────────────────────────────────────────

// Backoff for transient failures (SaaS still booting behind `depends_on`,
// 5xx, a lost registration race). Grows 2s → 4s → … capped at 30s; retries
// until the SaaS answers so a compose stack converges without a crash-loop.
const BACKOFF_START_MS = 2000;
const BACKOFF_CAP_MS = 30_000;

/**
 * Registers this daemon with the SaaS via a join token (minted in Settings →
 * Runners). Returns the per-runner bearer token; the caller persists it.
 *
 * Retries transient failures forever (the compose `runner` service typically
 * races the `gui` service at boot) and fails hard on auth/validation errors —
 * a revoked join token can never converge, so exiting loudly beats spinning.
 */
export async function registerWithJoinToken(opts: {
  url: string;
  joinToken: string;
  request: RunnerRegisterRequest;
}): Promise<RunnerRegisterResponse> {
  assertSecureRunnerUrl(opts.url);
  const endpoint = `${normalizeUrl(opts.url)}/api/runner/register`;
  let delay = BACKOFF_START_MS;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.joinToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(opts.request),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      console.warn(
        `[cezar-runner] register: SaaS unreachable (${err instanceof Error ? err.message : err}) — retrying in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, BACKOFF_CAP_MS);
      continue;
    }

    if (res.status === 401) {
      throw new Error(
        'cezar-runner: join token rejected (unknown or revoked). Mint a new one in Settings → Runners.',
      );
    }
    if (res.status === 400) {
      const body = await res.text().catch(() => '');
      throw new Error(`cezar-runner: register request invalid: ${body}`);
    }
    if (!res.ok) {
      // 409 (lost a duplicate-name race) and 5xx are both retryable.
      console.warn(
        `[cezar-runner] register: HTTP ${res.status} — retrying in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, BACKOFF_CAP_MS);
      continue;
    }

    const parsed = RunnerRegisterResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`cezar-runner: register response malformed: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
