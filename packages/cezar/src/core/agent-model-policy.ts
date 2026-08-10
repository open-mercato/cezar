import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { workspaceConfigPath } from '../paths.ts';

/** The server-side switch that makes native agent settings authoritative. */
export const AGENT_MODELS_LOCKED_ENV = 'CEZ_AGENT_MODELS_LOCKED';

const modelPolicyConfigSchema = z.object({
  modelsLocked: z.boolean().optional(),
}).passthrough();

/**
 * Only the exact environment value `1` enables the process-wide lock. The
 * global workspace config or one repository may additionally opt in with
 * `"modelsLocked": true`; missing, unreadable, malformed, and false values
 * preserve ordinary model selection unless another source enables the lock.
 */
export function agentModelsLocked(
  repoRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[AGENT_MODELS_LOCKED_ENV] === '1') return true;
  const paths = [
    workspaceConfigPath(env),
    ...(repoRoot ? [join(repoRoot, '.ai', 'cezar', 'config.json')] : []),
  ];
  for (const path of paths) {
    try {
      const parsed = modelPolicyConfigSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (parsed.success && parsed.data.modelsLocked === true) return true;
    } catch {
      // Each source is optional and independently degradable.
    }
  }
  return false;
}

export const AGENT_MODELS_LOCKED_ERROR =
  'agent models are locked — configure the model in the native coding-agent settings';
