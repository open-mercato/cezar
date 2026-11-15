import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildChildEnv } from './agent-env.ts';
import { resolveAntigravityBin } from './antigravity-runner.ts';
import type { ModelOption } from './runner-model-catalog.ts';
import { spawnableCommand } from './windows-shim.ts';

/** `agy models` prints a "Fetching…" banner, then one `<id>\t<label>` row per model (agy 1.4.0). */
export function parseAntigravityModelsOutput(output: string): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([a-z0-9][a-z0-9._-]*-[a-z0-9._-]+)\s+(.+?)\s*$/.exec(line);
    if (match && models.size < 200) models.set(match[1]!, { id: match[1]!, label: match[2]!, description: '' });
  }
  return [...models.values()];
}

export async function discoverAntigravityModels(): Promise<ModelOption[]> {
  const { stdout } = await promisify(execFile)(...spawnableCommand(resolveAntigravityBin(), ['models']), {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: buildChildEnv({ backend: 'antigravity' }),
  });
  const models = parseAntigravityModelsOutput(stdout);
  if (!models.length) throw new Error('Antigravity returned no models');
  return models;
}
