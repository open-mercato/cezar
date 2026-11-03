import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { worktreeLifecycleConfigSchema, type WorktreeLifecycleConfig } from '@open-mercato/cezar-contract';
import { assertLifecyclePath, atomicLifecycleWrite, LifecycleConflictError, LifecycleStoreError, withLifecycleFileLock } from './store.ts';

export class LifecycleConfigError extends Error {}
export type LifecycleConfigSnapshot = { config: WorktreeLifecycleConfig; revision: string | null; configured: boolean };

export function lifecycleConfigFromRaw(raw: unknown): LifecycleConfigSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LifecycleConfigError('Project configuration must be a JSON object');
  if (!Object.hasOwn(raw, 'worktreeLifecycle')) return { config: { afterCreate: [], beforeRemove: [] }, revision: null, configured: false };
  const value = (raw as Record<string, unknown>).worktreeLifecycle;
  const parsed = worktreeLifecycleConfigSchema.safeParse(value);
  if (!parsed.success) throw new LifecycleConfigError(`Invalid worktree lifecycle configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  // Hash the authored value, including unknown future keys; direct file edits participate in CAS.
  return { config: parsed.data, revision: createHash('sha256').update(JSON.stringify(value)).digest('hex'), configured: true };
}

export async function readLifecycleConfigRaw(projectRoot: string): Promise<Record<string, unknown>> {
  const path = join(projectRoot, '.ai', 'cezar', 'config.json');
  await assertLifecyclePath(path, projectRoot);
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new LifecycleConfigError('Project configuration cannot be read; worktree transition is paused');
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    return raw as Record<string, unknown>;
  } catch { throw new LifecycleConfigError('Project configuration is malformed; worktree transition is paused'); }
}
const UNCONFIGURED: LifecycleConfigSnapshot = { config: { afterCreate: [], beforeRemove: [] }, revision: null, configured: false };
export const TRACKED_CONFIG_ERROR = 'Worktree scripts in a git-tracked .ai/cezar/config.json are not run: scripts come only from local, untracked configuration. Untrack the file or remove its worktreeLifecycle key.';

/** A committed hook list would run on every clone with no consent (spec: local configuration only). */
export async function isLifecycleConfigTracked(projectRoot: string): Promise<boolean> {
  return promisify(execFile)('git', ['ls-files', '--error-unmatch', '--', join('.ai', 'cezar', 'config.json')], { cwd: projectRoot })
    .then(() => true, () => false);
}
/** The scripts Cezar may execute. Fails closed on an invalid list; a committed list counts as none. */
export async function readLifecycleConfig(projectRoot: string): Promise<LifecycleConfigSnapshot> {
  return trusted(projectRoot, lifecycleConfigFromRaw(await readLifecycleConfigRaw(projectRoot)));
}
/** Zero-config read for "are scripts configured?": an unreadable or malformed file, or a symlinked
 *  data directory, means none — what `loadConfig` already degrades to. A present key still fails closed. */
export async function readLifecycleConfigOrDefault(projectRoot: string, options: { trust?: boolean } = {}): Promise<LifecycleConfigSnapshot> {
  let raw: Record<string, unknown>;
  try { raw = await readLifecycleConfigRaw(projectRoot); }
  catch (error) {
    if (error instanceof LifecycleConfigError || error instanceof LifecycleStoreError) return UNCONFIGURED;
    throw error;
  }
  const snapshot = lifecycleConfigFromRaw(raw);
  // Settings shows an untrusted (committed) list too, so the user can remove it.
  return options.trust === false ? snapshot : trusted(projectRoot, snapshot);
}
// Treated as unconfigured rather than an error, so a repo that ships scripts keeps the zero-config path.
async function trusted(projectRoot: string, snapshot: LifecycleConfigSnapshot): Promise<LifecycleConfigSnapshot> {
  const scripts = snapshot.config.afterCreate.length + snapshot.config.beforeRemove.length;
  return scripts > 0 && await isLifecycleConfigTracked(projectRoot) ? UNCONFIGURED : snapshot;
}
export async function withLifecycleConfigLock<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
  const path = join(projectRoot, '.ai', 'cezar', 'config.lifecycle.lock');
  await assertLifecyclePath(path, projectRoot);
  return withLifecycleFileLock(path, action);
}
/** Call under withLifecycleConfigLock together with the surrounding raw read/merge/write. */
export function applyLifecycleConfigUpdate(raw: Record<string, unknown>, config: WorktreeLifecycleConfig | null, expectedRevision: string | null): Record<string, unknown> {
  const current = lifecycleConfigFromRaw(raw);
  if (current.revision !== expectedRevision) throw new LifecycleConflictError('Worktree scripts changed; reload settings before saving');
  const next = { ...raw };
  if (config === null) { delete next.worktreeLifecycle; delete next.worktreeLifecycleRevision; }
  else {
    // Entry validation never trims authored command text. Preserve future keys for surviving IDs.
    const parsed = worktreeLifecycleConfigSchema.parse(config);
    const old = raw.worktreeLifecycle as Record<string, unknown> | undefined;
    const oldEntries = new Map<string, Record<string, unknown>>();
    for (const phase of ['afterCreate', 'beforeRemove']) {
      const entries = old?.[phase];
      if (Array.isArray(entries)) for (const entry of entries) if (entry && typeof entry === 'object' && typeof entry.id === 'string') oldEntries.set(entry.id, entry);
    }
    const preserve = (entries: WorktreeLifecycleConfig['afterCreate']) => entries.map(entry => {
      const previous = { ...oldEntries.get(entry.id) };
      delete previous.name; delete previous.timeoutSeconds;
      return { ...previous, ...entry };
    });
    next.worktreeLifecycle = { ...old, afterCreate: preserve(parsed.afterCreate), beforeRemove: preserve(parsed.beforeRemove) };
    delete next.worktreeLifecycleRevision; // revisions are derived, never trusted from disk
  }
  return next;
}
export async function writeLifecycleConfig(projectRoot: string, config: WorktreeLifecycleConfig | null, expectedRevision: string | null): Promise<LifecycleConfigSnapshot> {
  return withLifecycleConfigLock(projectRoot, async () => {
    const next = applyLifecycleConfigUpdate(await readLifecycleConfigRaw(projectRoot), config, expectedRevision);
    await atomicLifecycleWrite(join(projectRoot, '.ai', 'cezar', 'config.json'), next);
    return lifecycleConfigFromRaw(next);
  });
}
