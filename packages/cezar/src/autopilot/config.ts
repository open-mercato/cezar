/**
 * Autopilot governor state — `~/.cezar/autopilot.json`.
 * Separate from workspace config so the feature is additive and deletable.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  autopilotGovernorSchema,
  defaultAutopilotGovernor,
  type AutopilotGovernor,
} from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';

const fileSchema = z
  .object({
    governor: autopilotGovernorSchema.catch(defaultAutopilotGovernor()),
  })
  .passthrough()
  .catch({ governor: defaultAutopilotGovernor() });

export function autopilotConfigPath(home = cezarHomeDir()): string {
  return join(home, 'autopilot.json');
}

export async function loadAutopilotGovernor(home = cezarHomeDir()): Promise<AutopilotGovernor> {
  try {
    const raw = JSON.parse(await readFile(autopilotConfigPath(home), 'utf8')) as unknown;
    return fileSchema.parse(raw).governor;
  } catch {
    return defaultAutopilotGovernor();
  }
}

export async function writeAutopilotGovernor(
  patch: Partial<AutopilotGovernor>,
  home = cezarHomeDir(),
): Promise<AutopilotGovernor> {
  const current = await loadAutopilotGovernor(home);
  const next: AutopilotGovernor = {
    maxSpendUsdPerHour:
      patch.maxSpendUsdPerHour !== undefined ? patch.maxSpendUsdPerHour : current.maxSpendUsdPerHour,
    maxRssMbTotal: patch.maxRssMbTotal !== undefined ? patch.maxRssMbTotal : current.maxRssMbTotal,
    stuckAfterMinutes:
      patch.stuckAfterMinutes !== undefined ? patch.stuckAfterMinutes : current.stuckAfterMinutes,
    softMaxParallel:
      patch.softMaxParallel !== undefined ? patch.softMaxParallel : current.softMaxParallel,
  };
  const parsed = autopilotGovernorSchema.parse(next);
  const path = autopilotConfigPath(home);
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ governor: parsed }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return parsed;
}
