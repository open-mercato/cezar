import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCursorAgentBin } from './cursor-agent-runner.ts';
import type { ModelOption } from './runner-model-catalog.ts';

const exec = promisify(execFile);

export interface CursorModelDiscoveryOptions {
  bin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests — defaults to `execFile(bin, ['models'], …)`. */
  run?: (bin: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_MODELS = 500;

/**
 * Parse `agent models` / `agent --list-models` text.
 * Lines look like: `composer-2.5 - Composer 2.5`. Skip headers, tips, and the
 * `auto` id (cezar already exposes empty-id auto as "no --model flag").
 */
export function parseCursorModelsOutput(text: string): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^available models$/i.test(line)) continue;
    if (/^tip:/i.test(line)) continue;
    const match = /^([^\s]+)\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1]!.trim();
    const label = match[2]!.trim();
    if (!id || id === 'auto' || seen.has(id)) continue;
    if (models.length >= MAX_MODELS) break;
    seen.add(id);
    models.push({ id, label: label || id, description: '' });
  }
  return models;
}

/** Discover models from the authenticated Cursor Agent CLI (`agent models`). */
export async function discoverCursorModels(
  options: CursorModelDiscoveryOptions = {},
): Promise<ModelOption[]> {
  const bin = resolveCursorAgentBin(options.bin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const run =
    options.run ??
    (async (executable, runEnv, timeout) =>
      exec(executable, ['models'], { timeout, env: runEnv, maxBuffer: 2 * 1024 * 1024 }));

  const { stdout, stderr } = await run(bin, env, timeoutMs);
  const models = parseCursorModelsOutput(`${stdout}\n${stderr}`);
  if (models.length === 0) {
    throw new Error('Cursor model discovery returned no models');
  }
  return models;
}
