/**
 * The live round-trips behind `ProbeTransport` (see `probe.ts` for why these
 * exist). Each one exercises the SAME code path the run will use — that is the
 * whole point. A probe that validates a different transport than the run
 * executes is how `opencode/mimo-v2.5-free` came back "ready" from a healthy
 * Zen HTTP endpoint while the local opencode server 500'd on every prompt.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProbeRef, ProbeTransport, ProbeVerdict } from './probe.js';

/** Smallest prompt that still proves the whole pipeline answers. */
const PROBE_PROMPT = 'Reply with exactly: OK';
const PROBE_TIMEOUT_MS = 45_000;
const SERVER_START_TIMEOUT_MS = 30_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** `opencode serve` + one real prompt. A session that creates fine but 500s on
 *  `message` (the schema-skew failure mode) is only visible if we post one. */
export async function probeOpencode(
  ref: ProbeRef,
  opts: { bin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<ProbeVerdict> {
  const bin = opts.bin ?? process.env.CEZ_OPENCODE_BIN ?? 'opencode';
  const port = await freePort();
  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: opts.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const done = (verdict: ProbeVerdict): ProbeVerdict => {
    if (!child.killed) child.kill('SIGTERM');
    return verdict;
  };

  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(
        () => reject(new Error(`opencode serve did not start within ${SERVER_START_TIMEOUT_MS}ms`)),
        SERVER_START_TIMEOUT_MS,
      );
      timer.unref?.();
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const m = /https?:\/\/[\d.]+:\d+/.exec(buffer);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      child.stdout.on('data', onData);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited (code ${code}) before listening`));
      });
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const created = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'cezar readiness probe' }),
        signal: controller.signal,
      });
      if (!created.ok) {
        return done({
          status: 'failed',
          detail: `POST /session → ${created.status} ${(await created.text()).slice(0, 200)}`,
        });
      }
      const sessionId = ((await created.json()) as { id?: string }).id;
      if (!sessionId) return done({ status: 'failed', detail: 'opencode returned no session id' });

      // `provider/model` → opencode's `{providerID, modelID}`.
      const slash = ref.model.indexOf('/');
      const body: Record<string, unknown> = { parts: [{ type: 'text', text: PROBE_PROMPT }] };
      if (slash > 0) {
        body.model = {
          providerID: ref.model.slice(0, slash),
          modelID: ref.model.slice(slash + 1),
        };
      }
      const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        return done({
          status: 'failed',
          detail: `POST /session/:id/message → ${res.status} ${detail}`.trim(),
        });
      }
      return done({ status: 'ready', detail: `round-trip ok via ${bin} serve` });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return done({ status: 'failed', detail: err instanceof Error ? err.message : String(err) });
  }
}

/** `codex exec` with one throwaway prompt, read-only and at low effort — the
 *  probe proves the CLI answers, it is not a reasoning benchmark. */
export async function probeCodex(
  ref: ProbeRef,
  opts: { bin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<ProbeVerdict> {
  const bin = opts.bin ?? process.env.CEZ_CODEX_BIN ?? 'codex';
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--config',
    'model_reasoning_effort=low',
    '--sandbox',
    'read-only',
    '--model',
    ref.model,
    '-',
  ];
  return new Promise<ProbeVerdict>((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd ?? process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (verdict: ProbeVerdict) => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill('SIGTERM');
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish({ status: 'failed', detail: `codex probe timed out after ${opts.timeoutMs ?? PROBE_TIMEOUT_MS}ms` }),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      finish({ status: 'failed', detail: err.message });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      finish(
        code === 0
          ? { status: 'ready', detail: `round-trip ok via ${bin} exec` }
          : { status: 'failed', detail: `${bin} exec exited ${code}: ${stderr.trim().slice(-300)}` },
      );
    });
    child.stdin.end(PROBE_PROMPT);
  });
}

/** Resolve an advisor credential the way the vendored runtime does: the
 *  declared env var first, then the opencode auth store. Returns the key and
 *  where it came from — never logs or returns it anywhere user-visible. */
export function resolveAdvisorCredential(model: {
  credentialEnv?: string;
  authStoreProvider?: string;
}): { key: string; source: string } | { key: null; reason: string } {
  if (model.credentialEnv && process.env[model.credentialEnv]) {
    return { key: String(process.env[model.credentialEnv]), source: `env ${model.credentialEnv}` };
  }
  if (model.authStoreProvider) {
    try {
      const store = JSON.parse(
        readFileSync(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8'),
      ) as Record<string, Record<string, string>>;
      const entry = store[model.authStoreProvider];
      const key = entry?.key ?? entry?.apiKey ?? entry?.access ?? entry?.token;
      if (key) return { key, source: `opencode auth store (${model.authStoreProvider})` };
    } catch {
      // absent or unreadable store — fall through to the miss below
    }
  }
  return {
    key: null,
    reason: `no credential: ${model.credentialEnv ?? '(no env var)'} unset and no opencode auth entry`,
  };
}

/** An OpenAI-compatible advisor (Zen, DeepSeek): one real completion. */
export async function probeAdvisorHttp(
  model: {
    model: string;
    endpoint?: string;
    credentialEnv?: string;
    authStoreProvider?: string;
  },
  opts: { timeoutMs?: number } = {},
): Promise<ProbeVerdict> {
  if (!model.endpoint) return { status: 'unverified', detail: 'no endpoint declared for this advisor' };
  const credential = resolveAdvisorCredential(model);
  if (credential.key === null) return { status: 'failed', detail: credential.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(model.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.key}` },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        status: 'failed',
        detail: `${model.endpoint} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim(),
      };
    }
    return { status: 'ready', detail: `round-trip ok via ${credential.source}` };
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the transport that routes a ref to its real code path. `advisors`
 *  supplies the `agentHarness.models` entry for `runner: 'harness'` refs. */
export function createLiveTransport(deps: {
  advisors?: Record<string, { model: string; preset?: string; endpoint?: string; credentialEnv?: string; authStoreProvider?: string }>;
  cwd?: string;
  timeoutMs?: number;
}): ProbeTransport {
  return async (ref) => {
    if (ref.runner === 'opencode') return probeOpencode(ref, { cwd: deps.cwd, timeoutMs: deps.timeoutMs });
    if (ref.runner === 'codex') return probeCodex(ref, { cwd: deps.cwd, timeoutMs: deps.timeoutMs });
    if (ref.runner === 'harness') {
      const advisor = deps.advisors?.[ref.model];
      if (!advisor) return { status: 'failed', detail: `advisor "${ref.model}" is not bound in agentHarness.models` };
      // A subscription CLI has no round-trip shape cezar owns. Say so plainly
      // rather than reporting a binary check as readiness.
      if (advisor.preset === 'kimi-subscription') {
        return {
          status: 'unverified',
          detail: 'subscription CLI — cezar has no round-trip probe for this adapter',
        };
      }
      return probeAdvisorHttp(advisor, { timeoutMs: deps.timeoutMs });
    }
    return { status: 'ready', detail: 'host session' };
  };
}
