import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface OpencodeModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, args: readonly string[], cwd: string) => ChildProcessWithoutNullStreams;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
/** Grace between the probe's SIGTERM and the SIGKILL that follows it. */
export const KILL_GRACE_MS = 2_000;
const MAX_MODELS = 500;
/** Defensive cap on what we buffer from a misbehaving child (characters of stdout). */
const MAX_OUTPUT_CHARS = 512 * 1_024;

/**
 * One `provider/model` id per line — the shape `opencode models` prints (#794). Deliberately
 * strict: anything else (a banner, a prompt, a stack trace, a bare model name that OpenCode
 * could not route) is NOT a model id, and silently turning it into a picker entry would
 * recreate the very defect this replaces.
 */
const MODEL_LINE_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i;

/** SGR/CSI sequences, in case a future CLI colorizes even a piped stdout. */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** The host binary, resolved exactly like `OpencodeServerRunner` and the backend probe. */
export function resolveOpencodeExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_OPENCODE_BIN ?? 'opencode';
}

/**
 * Discover the models the host's own OpenCode installation offers, by asking it: `opencode
 * models` lists every `provider/model` id the configured providers expose, which is the same
 * list OpenCode's own picker routes to.
 *
 * Best-effort by contract — `RunnerModelCatalog` turns any throw here into a cached or
 * `unavailable` answer, and `auto` stays selectable either way. No config is read or written,
 * no session is started; the child is short-lived and bounded by a deadline, a stdout cap and
 * a model cap.
 */
export async function discoverOpencodeModels(
  options: OpencodeModelDiscoveryOptions,
): Promise<ModelOption[]> {
  const bin = resolveOpencodeExecutable(options.bin);
  const args = ['models'] as const;
  const child = (options.spawn ?? spawnOpencode)(bin, args, options.cwd);
  const kill = teardown(child);

  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await new Promise<ModelOption[]>((resolve, reject) => {
      let stdout = '';
      let overflowed = false;

      const fail = (message: string) => {
        reject(new Error(message));
        kill();
      };

      timeout = setTimeout(() => fail('OpenCode model discovery timed out'), timeoutMs);
      timeout.unref?.();

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (overflowed) return;
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_CHARS) {
          overflowed = true;
          fail('OpenCode model discovery exceeded the output limit');
        }
      });
      // Drained but ignored: OpenCode prints provider warnings here, and an unread pipe would
      // eventually stall the child.
      child.stderr.resume();

      child.once('error', () => fail('OpenCode model discovery child failed'));
      child.once('close', (code) => {
        if (overflowed) return;
        if (code !== 0) {
          fail(`OpenCode model discovery child exited (${code ?? 'unknown'})`);
          return;
        }
        try {
          resolve(parseOpencodeModels(stdout));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    kill();
  }
}

/**
 * Turn `opencode models` output into picker options, preserving OpenCode's own order.
 *
 * Empty output is a legitimate answer (no provider configured yet) and yields no models, so the
 * picker shows `auto` alone. Output that contains lines but NO recognizable id is treated as a
 * failure instead: the CLI said something we cannot read, and reporting "unavailable" is more
 * honest than an empty catalog that looks like "you have no models".
 */
export function parseOpencodeModels(stdout: string): ModelOption[] {
  const lines = stdout
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const models: ModelOption[] = [];
  const ids = new Set<string>();
  for (const line of lines) {
    if (!MODEL_LINE_RE.test(line) || ids.has(line)) continue;
    if (models.length >= MAX_MODELS) throw new Error('OpenCode model discovery exceeded the size limit');
    ids.add(line);
    const provider = line.slice(0, line.indexOf('/'));
    models.push({ id: line, label: line, description: `via ${provider}` });
  }

  if (models.length === 0 && lines.length > 0) {
    throw new Error('OpenCode model discovery returned unrecognized output');
  }
  return models;
}

function spawnOpencode(
  bin: string,
  args: readonly string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  const child = nodeSpawn(bin, [...args], {
    cwd,
    env: buildChildEnv({ backend: 'opencode' }),
  });
  // Nothing is ever written to it, and an open stdin is what makes a CLI that expects a TTY
  // sit and wait instead of printing its list.
  child.stdin.end();
  return child;
}

/**
 * Returns the probe's teardown: SIGTERM now, SIGKILL once the grace window elapses.
 *
 * Both steps gate on the child's *real* termination, never on `child.killed` — Node flips that
 * flag the moment a signal is delivered, so the old `exitCode === null && !child.killed` test
 * went false the instant our own SIGTERM landed. A probe that installs a SIGTERM handler then
 * survived every teardown, leaking one process per cache refresh (#858, the shape #841 fixed for
 * the Claude probe in `a67b327d`).
 *
 * Called from both the failure path and the `finally`, so the escalation is armed at most once.
 */
function teardown(child: ChildProcessWithoutNullStreams): () => void {
  const hasExited = trackChildExit(child);
  let signalled = false;
  return () => {
    if (signalled || hasExited()) return;
    signalled = true;
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (hasExited()) return;
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    escalation.unref?.();
  };
}
