
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliRunner } from '../core/claude-cli-runner.js';
import type { ProbeRef, ProbeTransport, ProbeVerdict } from './probe.js';
import { harnessChildEnvironment, terminateProcessTree } from './runtime.js';

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

/** One real no-tools host round-trip. Provider discovery/login presence is not
 * enough: an expired Claude subscription must never render green. */
export async function probeClaude(
  ref: ProbeRef,
  opts: { bin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<ProbeVerdict> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const result = await new ClaudeCliRunner({
      ...(opts.bin ? { bin: opts.bin } : {}),
      timeoutMs,
    }).run({
      systemPrompt: 'You are a readiness probe. Use no tools and follow the response format exactly.',
      userPrompt: PROBE_PROMPT,
      cwd: opts.cwd ?? process.cwd(),
      allowedTools: [],
      model: ref.model || undefined,
      timeoutMs,
    });
    return result.text.trim()
      ? { status: 'ready', detail: 'round-trip ok via Claude host CLI' }
      : { status: 'failed', detail: 'Claude host CLI completed without a response' };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
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
    env: harnessChildEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  const done = (verdict: ProbeVerdict): ProbeVerdict => {
    terminateProcessTree(child);
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
        if (buffer.length < 64_000) buffer += chunk.toString('utf8').slice(0, 64_000 - buffer.length);
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
    const child = spawn(bin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: harnessChildEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stderr = '';
    let settled = false;
    const finish = (verdict: ProbeVerdict) => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child);
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish({ status: 'failed', detail: `codex probe timed out after ${opts.timeoutMs ?? PROBE_TIMEOUT_MS}ms` }),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 200_000) stderr += c.toString('utf8').slice(0, 200_000 - stderr.length);
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

function kimiBinary(model: { binaryEnv?: string }): string | null {
  const candidates = [
    model.binaryEnv ? process.env[model.binaryEnv] : undefined,
    join(homedir(), '.kimi', 'bin', 'kimi', 'kimi'),
    'kimi',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of [...new Set(candidates)]) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: harnessChildEnvironment(model.binaryEnv ? [model.binaryEnv] : []),
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

/** The same subscription CLI path the runtime's Kimi reviewer uses, with a tiny no-tools
 * prompt. A version check is insufficient: expired login/subscription state only appears on
 * an actual completion. */
export async function probeKimiSubscription(
  model: { model: string; binaryEnv?: string },
  opts: { timeoutMs?: number } = {},
): Promise<ProbeVerdict> {
  const binary = kimiBinary(model);
  if (!binary) {
    return {
      status: 'failed',
      detail: `missing Kimi CLI (${model.binaryEnv ?? 'OM_KIMI_BIN'} or managed subscription install)`,
    };
  }
  const temp = mkdtempSync(join(tmpdir(), 'cez-kimi-probe-'));
  const worktree = join(temp, 'worktree');
  const agentFile = join(temp, 'agent.yaml');
  const systemFile = join(temp, 'system.md');
  mkdirSync(worktree);
  writeFileSync(systemFile, 'You are a readiness probe with no tools. Follow the user response format exactly.\n');
  writeFileSync(
    agentFile,
    'version: 1\nagent:\n  name: readiness-probe\n  system_prompt_path: ./system.md\n  tools: []\n',
  );
  const args = [
    '--quiet',
    '--input-format',
    'text',
    '--thinking',
    '--agent-file',
    agentFile,
    '--work-dir',
    worktree,
    '--model',
    model.model,
  ];
  return new Promise<ProbeVerdict>((resolve) => {
    const child = spawn(binary, args, {
      cwd: worktree,
      env: {
        ...harnessChildEnvironment(model.binaryEnv ? [model.binaryEnv] : []),
        COLUMNS: '100000',
        NO_COLOR: '1',
        TERM: 'dumb',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (verdict: ProbeVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateProcessTree(child);
      rmSync(temp, { recursive: true, force: true });
      resolve(verdict);
    };
    const timer = setTimeout(
      () =>
        finish({
          status: 'failed',
          detail: `Kimi subscription probe timed out after ${opts.timeoutMs ?? PROBE_TIMEOUT_MS}ms`,
        }),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const current = target === 'stdout' ? stdout : stderr;
      const next = current + chunk.toString('utf8').slice(0, Math.max(0, 64_000 - current.length));
      if (target === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', (error) => finish({ status: 'failed', detail: error.message }));
    child.once('exit', (code) =>
      finish(
        code === 0 && stdout.trim()
          ? { status: 'ready', detail: `round-trip ok via ${binary}` }
          : {
              status: 'failed',
              detail: `Kimi CLI exited ${code}: ${(stderr || stdout).trim().slice(-300) || 'no response'}`,
            },
      ),
    );
    child.stdin.on('error', () => undefined);
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
  advisors?: Record<string, { model: string; preset?: string; endpoint?: string; credentialEnv?: string; authStoreProvider?: string; binaryEnv?: string }>;
  cwd?: string;
  timeoutMs?: number;
}): ProbeTransport {
  return async (ref) => {
    if (ref.runner === 'claude') {
      return probeClaude(ref, { cwd: deps.cwd, timeoutMs: deps.timeoutMs });
    }
    if (ref.runner === 'opencode') return probeOpencode(ref, { cwd: deps.cwd, timeoutMs: deps.timeoutMs });
    if (ref.runner === 'codex') return probeCodex(ref, { cwd: deps.cwd, timeoutMs: deps.timeoutMs });
    if (ref.runner === 'harness') {
      const advisor = deps.advisors?.[ref.model];
      if (!advisor) return { status: 'failed', detail: `advisor "${ref.model}" is not bound in agentHarness.models` };
      if (advisor.preset === 'kimi-subscription') {
        return probeKimiSubscription(advisor, { timeoutMs: deps.timeoutMs });
      }
      return probeAdvisorHttp(advisor, { timeoutMs: deps.timeoutMs });
    }
    return { status: 'failed', detail: `unsupported harness probe transport: ${ref.runner}` };
  };
}
