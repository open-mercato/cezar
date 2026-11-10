import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { localTimeZone, type DashboardAutomations } from '@open-mercato/cezar-contract';
import {
  automationDefinitionSchema,
  automationDefinitionsFileSchema,
  automationStateFileSchema,
} from '../automations/types.ts';

/** Only ENOENT means empty. Corrupt/unreadable state must not masquerade as no automations. */
async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Reads only the two existing files. Never opens a store/context, arms timers, or probes GitHub. */
export async function readDashboardAutomations(root: string): Promise<DashboardAutomations> {
  if (!(await stat(root)).isDirectory()) throw new Error('Project folder unavailable');
  const dir = join(root, '.ai/cezar');
  const [rawDefinitions, rawState] = await Promise.all([
    readJson(join(dir, 'automations.json'), { version: 1, automations: [] }),
    readJson(join(dir, 'automation-state.json'), { version: 1, states: {} }),
  ]);
  const definitions = automationDefinitionsFileSchema.parse(rawDefinitions).automations.map(
    (definition) => automationDefinitionSchema.parse(definition),
  );
  const states = automationStateFileSchema.parse(rawState).states;
  return {
    timeZone: localTimeZone(),
    automations: definitions.map((definition) => {
      const state = states[definition.id];
      // Match GET /automations: persisted deadline only, absent while paused or never armed.
      const nextRunAt = definition.enabled
        ? (definition.kind === 'schedule' ? state?.nextRunAt : state?.nextCheckAt)
        : undefined;
      return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        enabled: definition.enabled,
        ...(nextRunAt ? { nextRunAt } : {}),
        ...(state ? {
          state: {
            ...(state.backoffUntil ? { backoffUntil: state.backoffUntil } : {}),
            ...(state.consecutiveFailures !== undefined
              ? { consecutiveFailures: state.consecutiveFailures } : {}),
          },
        } : {}),
      };
    }),
  };
}
