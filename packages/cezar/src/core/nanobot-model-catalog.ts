import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildChildEnv } from './agent-env.ts';
import { spawnableCommand } from './windows-shim.ts';
import type { ModelOption } from './runner-model-catalog.ts';

const describeSchema = z.object({
  version: z.string().trim().min(1).max(200),
  ready: z.boolean(),
  models: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(200),
    description: z.string().max(2_000),
  })).max(200),
});

/** Only metadata: no model call or session is started by the bridge's describe command. */
export function parseNanobotDescription(stdout: string) {
  const result = describeSchema.parse(JSON.parse(stdout));
  if (new Set(result.models.map((model) => model.id)).size !== result.models.length) {
    throw new Error('Nanobot returned duplicate model presets');
  }
  return result;
}

export function resolveNanobotExecutable(): string {
  return process.env.CEZ_NANOBOT_BIN ?? (process.env.CEZ_DRY_RUN === '1'
    ? fileURLToPath(new URL('../../scripts/mock-nanobot-jsonl.mjs', import.meta.url))
    : 'nanobot-cezar');
}

export async function describeNanobot() {
  const { stdout } = await promisify(execFile)(...spawnableCommand(resolveNanobotExecutable(), ['--describe']), {
    timeout: 10_000,
    maxBuffer: 512 * 1_024,
    env: buildChildEnv({ backend: 'nanobot' }),
  });
  return parseNanobotDescription(stdout);
}

export async function discoverNanobotModels(): Promise<ModelOption[]> {
  const description = await describeNanobot();
  if (!description.ready) throw new Error('Nanobot local presets are not ready');
  return description.models;
}
