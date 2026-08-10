import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { buildChildEnv } from './agent-env.ts';
import { readNdjson } from './ndjson.ts';
import { resolveClaudeExecutable } from './claude-cli-runner.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface ClaudeModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, cwd: string) => ChildProcessWithoutNullStreams;
}

/**
 * One entry of the CLI's `list_models` answer. `value` is what `--model` accepts (an alias like
 * `sonnet`, a pinned id like `claude-fable-5`, or a context-window variant like `opus[1m]`);
 * `resolvedModel` is what that currently resolves to and is deliberately NOT surfaced — pinning
 * cezar to a resolved id would re-create the drift this issue is about. Unknown fields pass
 * through so a CLI that grows the payload does not fail the whole discovery.
 */
const modelSchema = z
  .object({
    value: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const listModelsSchema = z.object({ models: z.array(modelSchema) }).passthrough();

const controlResponseSchema = z.object({
  type: z.literal('control_response'),
  response: z
    .object({
      subtype: z.string(),
      request_id: z.string().optional(),
      response: z.unknown().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
});

/**
 * Wall-clock budget for one discovery. Generous next to Codex's 5 s because the Claude CLI has
 * to boot a full session host (measured ~5.6 s cold on a developer laptop) before it will answer
 * a control request.
 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
/** Defensive cap — a catalog this long is a malfunction, not a rollout. */
const MAX_MODELS = 200;
/** Grace between closing stdin and SIGTERM, then between SIGTERM and SIGKILL. */
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 2_000;
const REQUEST_ID = 'cez-list-models-1';

/**
 * The `value` that stands for "whatever the CLI would pick on its own". cezar already spells that
 * `auto` (no `--model` flag at all), so surfacing the CLI's own entry too would put two rows in
 * the picker meaning the same thing — and `default` is a picker token, not necessarily something
 * `--model` accepts.
 */
const IMPLICIT_DEFAULT_VALUE = 'default';

/**
 * Spawn flags for a discovery probe. `--print` + stream-json is the same headless transport the
 * runner uses, so the control channel is available; `--safe-mode` keeps a probe from executing
 * the user's SessionStart hooks, MCP servers and plugins (discovery must not have side effects,
 * and it needs none of them), while leaving auth and model selection — the only things it asks
 * about — working normally. `--no-session-persistence` keeps a probe out of the resume picker.
 */
const DISCOVERY_ARGS = [
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--safe-mode',
  '--no-session-persistence',
];

function spawnClaudeProbe(bin: string, cwd: string): ChildProcessWithoutNullStreams {
  return nodeSpawn(bin, DISCOVERY_ARGS, {
    cwd,
    env: buildChildEnv({ backend: 'claude' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Discover the model catalog the host's authenticated Claude Code CLI actually offers.
 *
 * The CLI answers a `list_models` control request over the same stream-json channel the runner
 * already speaks, which makes it the Claude counterpart of the Codex app-server's `model/list`
 * (spec `.ai/specs/2026-07-21-codex-latest-model-discovery.md`). The probe never starts a turn,
 * so it costs no tokens; it is bounded by a deadline and always terminates its child.
 *
 * Every failure — no CLI, a CLI too old to know `list_models`, not logged in, a malformed answer,
 * a timeout — throws, so `RunnerModelCatalog` degrades to `unavailable` and the picker falls back
 * to the static tier aliases rather than showing an empty list.
 */
export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions,
): Promise<ModelOption[]> {
  const child = (options.spawn ?? spawnClaudeProbe)(
    resolveClaudeExecutable(options.bin),
    options.cwd,
  );

  // A probe reads only stdout, but an undrained stderr pipe fills and wedges the child, and an
  // unhandled stream `error` would take the whole server down with it.
  child.stderr.resume();
  child.stderr.on('error', () => {});
  child.stdin.on('error', () => {});

  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      readCatalog(child),
      childFailure(child),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Claude model discovery timed out')), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    endClaudeProbe(child);
  }
}

/** Rejects when the child dies before answering — a missing binary or an immediate exit. */
function childFailure(child: ChildProcessWithoutNullStreams): Promise<never> {
  return new Promise<never>((_, reject) => {
    child.once('error', () => reject(new Error('Claude model discovery child failed')));
    child.once('exit', (code) =>
      reject(new Error(`Claude model discovery child exited (${code ?? 'unknown'})`)),
    );
  });
}

async function readCatalog(child: ChildProcessWithoutNullStreams): Promise<ModelOption[]> {
  try {
    child.stdin.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: REQUEST_ID,
        request: { subtype: 'list_models' },
      })}\n`,
    );
  } catch {
    throw new Error('Claude model discovery could not reach the CLI');
  }

  for await (const line of readNdjson(child.stdout)) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error('Claude model discovery returned malformed NDJSON');
    }
    // The CLI interleaves session/hook chatter with control traffic; ignore everything that is
    // not the answer to our own request rather than guessing at the stream's shape.
    const parsed = controlResponseSchema.safeParse(message);
    if (!parsed.success) continue;
    const { response } = parsed.data;
    if (response.request_id !== undefined && response.request_id !== REQUEST_ID) continue;
    if (response.subtype !== 'success') {
      // An older CLI answers `Unsupported control request subtype: list_models` here. That is an
      // unavailable catalog, not a broken cezar — the reason is never surfaced verbatim.
      throw new Error('Claude model discovery is unsupported by this CLI');
    }
    return toModelOptions(response.response);
  }

  throw new Error('Claude model discovery ended without an answer');
}

function toModelOptions(payload: unknown): ModelOption[] {
  const parsed = listModelsSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Claude model discovery returned malformed model data');

  const models: ModelOption[] = [];
  const ids = new Set<string>();
  for (const model of parsed.data.models) {
    const id = model.value.trim();
    if (!id || id === IMPLICIT_DEFAULT_VALUE || ids.has(id)) continue;
    if (models.length >= MAX_MODELS) throw new Error('Claude model discovery exceeded the size limit');
    ids.add(id);
    models.push({
      id,
      label: model.displayName?.trim() || id,
      description: model.description?.trim() ?? '',
    });
  }

  // A CLI that answers with lines but nothing usable is a protocol mismatch, not an account with
  // no models — report it as unavailable so the static aliases keep the picker working.
  if (models.length === 0) throw new Error('Claude model discovery returned no usable models');
  return models;
}

/** Close stdin, then escalate TERM → KILL so a wedged probe can never outlive its request. */
function endClaudeProbe(child: ChildProcessWithoutNullStreams): void {
  try {
    child.stdin.end();
  } catch {
    // already gone
  }
  const term = setTimeout(() => {
    if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
    const kill = setTimeout(() => {
      if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    kill.unref?.();
  }, TERM_GRACE_MS);
  term.unref?.();
}
