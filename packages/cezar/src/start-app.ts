import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startAppRecipeSchema, type EffectiveStartApp, type StartAppRecipe, type StartAppState } from '@open-mercato/cezar-contract';

import { LifecycleConfigError, readLifecycleConfigRaw, withLifecycleConfigLock } from './worktree-lifecycle/config.ts';
import { atomicLifecycleWrite, LifecycleStoreError } from './worktree-lifecycle/store.ts';
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

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readRaw(dataDir: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(dataDir, 'config.json'), 'utf8').catch(() => null);
  return (text === null ? null : parseObject(text)) ?? {};
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
    // Written the way `PUT /config` writes this file: under the config writers' shared lock, and a
    // malformed file is refused rather than replaced by `{ startApp }`.
    const apply = (raw: Record<string, unknown>) => {
      if (recipe) raw[KEY] = recipe;
      else delete raw[KEY];
      return raw;
    };
    const path = join(dataDir, 'config.json');
    try {
      await withLifecycleConfigLock(root, async () => atomicLifecycleWrite(path, apply(await readLifecycleConfigRaw(root))));
    } catch (error) {
      // The lifecycle store refuses a symlinked data dir; the plain write `PUT /config` falls back to.
      if (!(error instanceof LifecycleStoreError)) throw error;
      const text = await readFile(path, 'utf8').catch(() => null);
      const raw = text === null ? {} : parseObject(text);
      if (!raw) throw new LifecycleConfigError('Project configuration is malformed; fix .ai/cezar/config.json first');
      await mkdir(dataDir, { recursive: true });
      await writeFile(path, `${JSON.stringify(apply(raw), null, 2)}\n`, 'utf8');
    }
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
