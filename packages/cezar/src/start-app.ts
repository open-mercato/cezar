import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startAppRecipeSchema, type EffectiveStartApp, type StartAppRecipe, type StartAppState } from '@open-mercato/cezar-contract';

import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';

/**
 * A project's start recipe (spec `2026-10-09-design-mode` §7c): `startApp` in the repo's
 * `.ai/cezar/config.json` (the team's) and in the project's entry of `~/.cezar/config.json`
 * (yours, which wins). Optional in both; a value that does not parse counts as absent.
 */
const KEY = 'startApp';

function parse(value: unknown): StartAppRecipe | null {
  const parsed = startAppRecipeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function readRaw(dataDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readStartApp(dataDir: string, root: string): Promise<StartAppState> {
  const entry = (await loadWorkspaceConfig()).projects.find((project) => project.root === root);
  return {
    project: parse((await readRaw(dataDir))[KEY]),
    personal: entry ? parse((entry as Record<string, unknown>)[KEY]) : null,
    personalAvailable: entry !== undefined,
  };
}

export function effectiveStartApp(state: StartAppState): EffectiveStartApp | null {
  if (state.personal) return { ...state.personal, scope: 'personal' };
  if (state.project) return { ...state.project, scope: 'project' };
  return null;
}

/** Writes one scope. Every other key of either file is kept as it was. */
export async function writeStartApp(
  dataDir: string,
  root: string,
  scope: 'project' | 'personal',
  recipe: StartAppRecipe | null,
): Promise<boolean> {
  if (scope === 'project') {
    // Written the way `PUT /config` writes this file: plain, readable, committable.
    const raw = await readRaw(dataDir);
    if (recipe) raw[KEY] = recipe;
    else delete raw[KEY];
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return true;
  }
  let found = false;
  await mergeWriteWorkspaceConfig((config) => {
    const entry = config.projects.find((project) => project.root === root) as Record<string, unknown> | undefined;
    if (!entry) return;
    found = true;
    if (recipe) entry[KEY] = recipe;
    else delete entry[KEY];
  });
  return found;
}
