import { androidEmulatorRecipe, androidSdkRecipe } from './android.ts';
import { flutterRecipe } from './flutter.ts';
import { iosSimulatorRecipe } from './ios.ts';
import { jdkRecipe } from './jdk.ts';
import { withToolLock } from './lock.ts';
import { type ToolEnv, type ToolId, type ToolRecipe, type ToolsContext, defaultContext, envKey, pathDelimiter, sweepStaging } from './runtime.ts';

/** The recipe registry, detection, `ensure` and environment composition. */

export const RECIPES: readonly ToolRecipe[] = [jdkRecipe, androidSdkRecipe, androidEmulatorRecipe, iosSimulatorRecipe, flutterRecipe];
export const TOOL_IDS: readonly ToolId[] = RECIPES.map((r) => r.id);

export function getRecipe(id: string): ToolRecipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export interface ToolReport {
  id: ToolId;
  title: string;
  status: 'ready' | 'installed' | 'missing' | 'unsupported' | 'blocked' | 'failed';
  version?: string;
  path?: string;
  source?: 'system' | 'cezar';
  message?: string;
}

export const ENABLE_HINT = 'cezar installs tools only when enabled: Settings → Resources → Test toolchains, or CEZ_TOOL_INSTALL=1 in the environment that starts cezar';

/** Union of what every recipe contributes; PATH entries de-duplicated, later vars win. */
export function composeToolsEnv(ctx: ToolsContext, managedOnly = false): ToolEnv {
  const path = new Set<string>();
  const vars: Record<string, string> = {};
  for (const recipe of RECIPES) {
    if (recipe.unsupported(ctx)) continue;
    const env = recipe.env(ctx, managedOnly);
    for (const p of env.path) path.add(p);
    Object.assign(vars, env.vars);
  }
  return { path: [...path], vars };
}

/** `base` with the tools' PATH entries in front and their variables set (PATH spelled as `base` spells it). */
export function applyToolsEnv(base: NodeJS.ProcessEnv, tools: ToolEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (tools.path.length === 0 && Object.keys(tools.vars).length === 0) return { ...base };
  const key = envKey(base, 'PATH');
  const existing = base[key];
  return {
    ...base,
    [key]: [...tools.path, ...(existing ? [existing] : [])].join(pathDelimiter(platform)),
    ...tools.vars,
  };
}

/**
 * The additions an agent launch makes for tools cezar installed: only the keys that change
 * (so `{}` when nothing was provisioned), stat-only, never installs, never throws.
 */
export function managedToolsEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  try {
    const ctx = defaultContext(env);
    const tools = composeToolsEnv(ctx, true);
    if (tools.path.length === 0 && Object.keys(tools.vars).length === 0) return {};
    const merged = applyToolsEnv(env, tools, ctx.platform);
    const out: Record<string, string> = {};
    for (const key of [envKey(env, 'PATH'), ...Object.keys(tools.vars)]) if (merged[key] !== undefined && merged[key] !== env[key]) out[key] = merged[key]!;
    return out;
  } catch {
    return {};
  }
}

export async function statusAll(ctx: ToolsContext): Promise<ToolReport[]> {
  const reports: ToolReport[] = [];
  for (const recipe of RECIPES) reports.push(await statusOf(ctx, recipe));
  return reports;
}

async function statusOf(ctx: ToolsContext, recipe: ToolRecipe): Promise<ToolReport> {
  const base = { id: recipe.id, title: recipe.title };
  const why = recipe.unsupported(ctx);
  if (why) return { ...base, status: 'unsupported', message: why };
  try {
    const found = await recipe.detect(ctx);
    return found.installed
      ? { ...base, status: 'ready', version: found.version, path: found.path, source: found.source }
      : { ...base, status: 'missing', path: found.path, message: found.note };
  } catch (error) {
    return { ...base, status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** `ids` plus everything they require, dependencies first, each once. */
export function expandIds(ids: readonly ToolId[]): ToolId[] {
  const order: ToolId[] = [];
  const visit = (id: ToolId): void => {
    if (order.includes(id)) return;
    for (const dep of getRecipe(id)?.requires ?? []) visit(dep);
    order.push(id);
  };
  ids.forEach(visit);
  return order;
}

/**
 * Make each tool ready: detect; if missing and installs are enabled, install under the tool's
 * lock (re-detecting inside it, since a sibling process may have just finished) and re-detect.
 * Never throws — a failure is the tool's `failed` report, and its dependents are `blocked`.
 */
export async function ensureTools(ctx: ToolsContext, ids: readonly ToolId[]): Promise<ToolReport[]> {
  const reports = new Map<ToolId, ToolReport>();
  for (const id of expandIds(ids)) {
    const recipe = getRecipe(id)!;
    const blocker = recipe.requires.find((dep) => !['ready', 'installed'].includes(reports.get(dep)?.status ?? ''));
    if (blocker && !recipe.unsupported(ctx)) {
      reports.set(id, { id, title: recipe.title, status: 'blocked', message: `needs ${blocker}, which is not ready` });
      continue;
    }
    let report = await statusOf(ctx, recipe);
    if (report.status === 'missing') {
      if (!ctx.install) {
        report = { ...report, message: [report.message, `install it yourself (${recipe.hint(ctx)}). ${ENABLE_HINT}.`].filter(Boolean).join('; ') };
      } else {
        report = await installLocked(ctx, recipe);
      }
    }
    reports.set(id, report);
  }
  return expandIds(ids).map((id) => reports.get(id)!);
}

async function installLocked(ctx: ToolsContext, recipe: ToolRecipe): Promise<ToolReport> {
  try {
    return await withToolLock(ctx, recipe.id, async () => {
      await sweepStaging(ctx, recipe.id);
      const already = await statusOf(ctx, recipe);
      if (already.status === 'ready') return already;
      ctx.log(`installing ${recipe.id}: ${recipe.title}`);
      await recipe.install(ctx, applyToolsEnv(ctx.env, composeToolsEnv(ctx), ctx.platform));
      const after = await statusOf(ctx, recipe);
      if (after.status !== 'ready') {
        return { ...after, status: 'failed' as const, message: `installed but not detected${after.message ? `: ${after.message}` : ''}` };
      }
      return { ...after, status: 'installed' as const };
    });
  } catch (error) {
    return { id: recipe.id, title: recipe.title, status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}
