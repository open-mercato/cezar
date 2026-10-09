import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildChildEnv } from './agent-env.ts';
import type { ModelOption } from './runner-model-catalog.ts';

const exec = promisify(execFile);

export interface PiModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to `pi --list-models`. */
  run?: (bin: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_MODELS = 500;
const MAX_OUTPUT_CHARS = 512 * 1_024;
const HEADER = /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/i;
const ROW = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(yes|no)\s+(yes|no)$/i;
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * Resolve the pi binary the way the runner does for a real session (`CEZ_PI_BIN`, else `pi` on
 * PATH). Deliberately NOT the runner's `CEZ_DRY_RUN=1` branch: that points at `mock-pi-rpc.mjs`,
 * an RPC stdin loop with no `--list-models`, so probing it would stall until the timeout. Under
 * dry run discovery therefore degrades to the shared unavailable fallback, like every other
 * runner's catalog.
 */
export function resolvePiExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_PI_BIN ?? 'pi';
}

/**
 * Parse the table printed by `pi --list-models`.
 *
 * Only complete provider/model rows are accepted. That keeps warnings, help text and a future
 * format change out of the picker instead of accidentally advertising an ID Pi cannot use.
 */
export function parsePiModelsOutput(text: string): ModelOption[] {
  const lines = text
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  let sawRows = false;
  let sawEmptyNotice = false;
  for (const line of lines) {
    if (HEADER.test(line)) continue;
    if (/^no models available/i.test(line)) {
      sawEmptyNotice = true;
      continue;
    }
    const match = ROW.exec(line);
    if (!match) continue;
    sawRows = true;
    const id = `${match[1]}/${match[2]}`;
    if (seen.has(id)) continue;
    if (models.length >= MAX_MODELS) throw new Error('Pi model discovery exceeded the size limit');
    seen.add(id);
    models.push({ id, label: match[2]!, description: `via ${match[1]}` });
  }
  if (models.length === 0 && lines.length > 0 && !sawRows && !sawEmptyNotice) {
    throw new Error('Pi model discovery returned unrecognized output');
  }
  return models;
}

/** Discover the configured Pi catalog without starting a session or changing Pi state. */
export async function discoverPiModels(options: PiModelDiscoveryOptions): Promise<ModelOption[]> {
  const bin = resolvePiExecutable(options.bin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const run = options.run ?? (async (executable, args, cwd, timeout) =>
    exec(executable, [...args], {
      cwd,
      env: buildChildEnv({ backend: 'pi' }),
      timeout,
      maxBuffer: MAX_OUTPUT_CHARS,
    }));
  const { stdout } = await run(bin, ['--list-models'], options.cwd, timeoutMs);
  if (stdout.length > MAX_OUTPUT_CHARS) throw new Error('Pi model discovery exceeded the output limit');
  return parsePiModelsOutput(stdout);
}
