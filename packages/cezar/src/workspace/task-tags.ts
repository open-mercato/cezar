import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  RUN_TAGS_MAX,
  TASK_TAG_COLORS,
  TASK_TAGS_MAX,
  taskTagColorSchema,
  taskTagIdSchema,
  type RunTag,
  type TaskTag,
  type TaskTagColor,
  type TaskTagRef,
} from '@open-mercato/cezar-contract';
import { taskTagsPath } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

/**
 * `~/.cezar/task-tags.json` — the task-tag registry (spec `2026-11-23-task-tags.md` § 4.2).
 *
 * Its own file for the `agent-accounts.json` reason, and with its house rules: `.catch` per field,
 * `.passthrough()` at every level, per-row salvage, one atomic merge-write, and a corrupt file
 * degrading to empty with one warning. A project-scoped tag stores the realpath'd root, never the
 * slug (D3); the wire speaks `projectId`, resolved against the registry on every read.
 */

/** Tombstones kept; the oldest go first. A dropped one can only bring a tag back as a snapshot chip. */
export const TASK_TAG_TOMBSTONES_MAX = 2000;

const storedTagSchema = z
  .object({
    id: taskTagIdSchema,
    name: z.string().trim().min(1),
    color: taskTagColorSchema.optional().catch(undefined),
    description: z.string().optional().catch(undefined),
    projectRoot: z.string().min(1).optional().catch(undefined),
    createdAt: z.string().catch(''),
    lastUsedAt: z.string().optional().catch(undefined),
  })
  .passthrough();
export type StoredTaskTag = z.infer<typeof storedTagSchema>;

const tombstoneSchema = z.object({ id: taskTagIdSchema, deletedAt: z.string().catch('') }).passthrough();
export type TaskTagTombstone = z.infer<typeof tombstoneSchema>;

function salvage<T extends { id: string }>(schema: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .default(() => [])
    .catch(() => [])
    .transform((rows) => {
      const seen = new Set<string>();
      return rows.flatMap((row) => {
        const parsed = schema.safeParse(row);
        if (!parsed.success || seen.has(parsed.data.id)) return [];
        seen.add(parsed.data.id);
        return [parsed.data];
      });
    });
}

const storeSchema = z
  .object({
    version: z.number().int().min(0).default(1).catch(1),
    tags: salvage(storedTagSchema),
    deleted: salvage(tombstoneSchema),
  })
  .passthrough();
export type TaskTagStore = z.infer<typeof storeSchema>;

export function defaultTaskTagStore(): TaskTagStore {
  return storeSchema.parse({});
}

/** A refusal the routes turn into a status: 400 bad ref, 404 unknown tag, 409 conflict or cap. */
export class TaskTagError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'TaskTagError';
  }
}

/** The registry could not be persisted (read-only home) — the routes answer 500. */
export class TaskTagWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTagWriteError';
  }
}

let warnedCorrupt = false;

/** Read on demand, never cached (every cezar process shares `~/.cezar`), never throws. */
export async function loadTaskTags(): Promise<TaskTagStore> {
  const path = taskTagsPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return defaultTaskTagStore();
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to the warning + defaults
  }
  if (!warnedCorrupt) {
    warnedCorrupt = true;
    console.warn(`[cez] task tags ${path} is corrupt — ignoring it (no tags until the next tag edit replaces it)`);
  }
  return defaultTaskTagStore();
}

/** Test seam: the corrupt-file warning is once per process. */
export function resetTaskTagWarningForTests(): void {
  warnedCorrupt = false;
}

/**
 * Re-read, apply `mutator`, write atomically. The mutator is synchronous so the read→rename window
 * stays as small as every other `~/.cezar` writer's. A `TaskTagError` thrown by the mutator aborts
 * without writing; a failed write throws `TaskTagWriteError`.
 */
export async function mergeWriteTaskTags(mutator: (store: TaskTagStore) => void): Promise<TaskTagStore> {
  const store = await loadTaskTags();
  mutator(store);
  if (store.deleted.length > TASK_TAG_TOMBSTONES_MAX) {
    store.deleted.sort((a, b) => a.deletedAt.localeCompare(b.deletedAt));
    store.deleted.splice(0, store.deleted.length - TASK_TAG_TOMBSTONES_MAX);
  }
  try {
    atomicWriteJsonSync(taskTagsPath(), store);
  } catch (error) {
    throw new TaskTagWriteError(`could not save task tags: ${error instanceof Error ? error.message : String(error)}`);
  }
  return store;
}

// ---- pure helpers ---------------------------------------------------------------------------

/** D6's comparison key: the project-tags rule (`normalizeProjectTags`). */
export function tagNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A new tag created without a color gets a random palette color, never the neutral `gray`. */
export function randomTaskTagColor(): TaskTagColor {
  const palette = TASK_TAG_COLORS.filter((c) => c !== 'gray');
  return palette[randomInt(palette.length)]!;
}

export function allocateTaskTagId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const id = `tt-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
    if (id.length === 15 && !taken.has(id)) return id;
  }
}

/** A tag is visible in a project when it is global or scoped to that project's root (D6). */
export function visibleTaskTags(store: TaskTagStore, projectRoot: string | null): StoredTaskTag[] {
  return store.tags.filter((tag) => tag.projectRoot === undefined || tag.projectRoot === projectRoot);
}

/** Wire shape: the root becomes the registry's `projectId`, or `orphaned` when none matches (D3). */
export function toWireTaskTag(tag: StoredTaskTag, idForRoot: (root: string) => string | undefined): TaskTag {
  const projectId = tag.projectRoot === undefined ? undefined : idForRoot(tag.projectRoot);
  return {
    id: tag.id,
    name: tag.name,
    ...(tag.color !== undefined ? { color: tag.color } : {}),
    ...(tag.description !== undefined && tag.description !== '' ? { description: tag.description } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(tag.projectRoot !== undefined && projectId === undefined ? { orphaned: true as const } : {}),
    createdAt: tag.createdAt,
    ...(tag.lastUsedAt !== undefined ? { lastUsedAt: tag.lastUsedAt } : {}),
  };
}

export function listTaskTags(
  store: TaskTagStore,
  idForRoot: (root: string) => string | undefined,
): { tags: TaskTag[]; deletedIds: string[] } {
  return { tags: store.tags.map((tag) => toWireTaskTag(tag, idForRoot)), deletedIds: store.deleted.map((t) => t.id) };
}

export function toRunTag(tag: StoredTaskTag): RunTag {
  return { id: tag.id, name: tag.name, ...(tag.color !== undefined ? { color: tag.color } : {}) };
}

/**
 * The live tag `name` would collide with when it lives in `scopeRoot` (null = global), ignoring
 * `selfId`. A global tag is visible everywhere, so it collides with every live tag of that name.
 */
function nameConflict(store: TaskTagStore, name: string, scopeRoot: string | null, selfId?: string): StoredTaskTag | undefined {
  const key = tagNameKey(name);
  return store.tags.find(
    (tag) =>
      tag.id !== selfId &&
      tagNameKey(tag.name) === key &&
      (scopeRoot === null || tag.projectRoot === undefined || tag.projectRoot === scopeRoot),
  );
}

function assertUnderCap(store: TaskTagStore): void {
  if (store.tags.length >= TASK_TAGS_MAX) {
    throw new TaskTagError(409, `there are already ${TASK_TAGS_MAX} task tags — delete a tag first`);
  }
}

function insertTag(
  store: TaskTagStore,
  input: { name: string; color?: TaskTagColor; description?: string; projectRoot: string | null },
  now: Date,
): StoredTaskTag {
  assertUnderCap(store);
  const taken = new Set([...store.tags.map((t) => t.id), ...store.deleted.map((t) => t.id)]);
  const tag: StoredTaskTag = {
    id: allocateTaskTagId(taken),
    name: input.name.trim(),
    color: input.color ?? randomTaskTagColor(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.projectRoot !== null ? { projectRoot: input.projectRoot } : {}),
    createdAt: now.toISOString(),
  };
  store.tags.push(tag);
  return tag;
}

/** `POST /workspace/task-tags`: a name taken in the target scope is a 409 (D6). */
export function createTaskTag(
  store: TaskTagStore,
  input: { name: string; color?: TaskTagColor; description?: string; projectRoot: string | null },
  now = new Date(),
): StoredTaskTag {
  const conflict = nameConflict(store, input.name, input.projectRoot);
  if (conflict) throw new TaskTagError(409, `a tag named "${conflict.name}" already exists`);
  return insertTag(store, input, now);
}

/** `PATCH /workspace/task-tags/:id`: a field applies only when the patch names it. */
export function updateTaskTag(
  store: TaskTagStore,
  id: string,
  patch: { name?: string; color?: TaskTagColor | null; description?: string | null; global?: true },
): StoredTaskTag {
  const tag = store.tags.find((t) => t.id === id);
  if (!tag) throw new TaskTagError(404, 'unknown task tag');
  const nextScope = patch.global ? null : (tag.projectRoot ?? null);
  const nextName = patch.name ?? tag.name;
  if (patch.name !== undefined || patch.global) {
    const conflict = nameConflict(store, nextName, nextScope, tag.id);
    if (conflict) throw new TaskTagError(409, `a tag named "${conflict.name}" already exists`);
  }
  if (patch.name !== undefined) tag.name = patch.name.trim();
  if (patch.color !== undefined) {
    if (patch.color === null) delete tag.color;
    else tag.color = patch.color;
  }
  if (patch.description !== undefined) {
    if (patch.description === null || patch.description === '') delete tag.description;
    else tag.description = patch.description;
  }
  if (patch.global) delete tag.projectRoot;
  return tag;
}

/** `DELETE`: a live tag becomes a tombstone (D9); deleting twice is idempotent; unknown is 404. */
export function deleteTaskTag(store: TaskTagStore, id: string, now = new Date()): void {
  const index = store.tags.findIndex((t) => t.id === id);
  if (index === -1) {
    if (store.deleted.some((t) => t.id === id)) return;
    throw new TaskTagError(404, 'unknown task tag');
  }
  store.tags.splice(index, 1);
  store.deleted.push({ id, deletedAt: now.toISOString() });
}

/**
 * Resolve refs against `store` for a task in `projectRoot` (D6/D7): an id must be live and
 * visible there, a name reuses a visible tag of that name or creates a project-scoped one. Applied
 * tags get `lastUsedAt` bumped. Mutates `store`; returns the tags plus whether any was created.
 */
export function resolveTagRefsIn(
  store: TaskTagStore,
  refs: readonly TaskTagRef[],
  projectRoot: string | null,
  now = new Date(),
): { tags: RunTag[]; created: boolean } {
  const out = new Map<string, StoredTaskTag>();
  let created = false;
  for (const ref of refs) {
    let tag: StoredTaskTag | undefined;
    if ('id' in ref) {
      tag = store.tags.find((t) => t.id === ref.id);
      if (!tag) {
        throw new TaskTagError(400, store.deleted.some((t) => t.id === ref.id) ? `task tag ${ref.id} was deleted` : `unknown task tag ${ref.id}`);
      }
      if (tag.projectRoot !== undefined && tag.projectRoot !== projectRoot) {
        throw new TaskTagError(400, `task tag "${tag.name}" belongs to another project`);
      }
    } else {
      const key = tagNameKey(ref.name);
      tag = visibleTaskTags(store, projectRoot).find((t) => tagNameKey(t.name) === key);
      if (!tag) {
        tag = insertTag(store, { name: ref.name, projectRoot }, now);
        created = true;
      }
    }
    tag.lastUsedAt = now.toISOString();
    out.set(tag.id, tag);
  }
  if (out.size > RUN_TAGS_MAX) throw new TaskTagError(400, `a task can carry at most ${RUN_TAGS_MAX} tags`);
  return { tags: [...out.values()].map(toRunTag), created };
}

/**
 * Resolve refs and persist what that changed. A created tag must be written (a failed write is a
 * `TaskTagWriteError`); a mere `lastUsedAt` bump is best-effort, so applying existing tags still
 * works on a read-only home (§ 9).
 */
export async function resolveTagRefs(
  refs: readonly TaskTagRef[],
  projectRoot: string | null,
  now = new Date(),
): Promise<{ tags: RunTag[] }> {
  if (refs.length === 0) return { tags: [] };
  let result: { tags: RunTag[]; created: boolean } | undefined;
  try {
    await mergeWriteTaskTags((store) => {
      result = resolveTagRefsIn(store, refs, projectRoot, now);
    });
  } catch (error) {
    if (!(error instanceof TaskTagWriteError) || result === undefined || result.created) throw error;
  }
  return { tags: result!.tags };
}

/** Apply a delta to a run's tags (D8). `add` refreshes a snapshot already present; a missing
 *  `remove` is a no-op. Overflow is a 400 that changes nothing. */
export function applyRunTagDelta(current: readonly RunTag[] | undefined, add: readonly RunTag[], remove: readonly string[]): RunTag[] {
  const removed = new Set(remove);
  const next = (current ?? []).filter((tag) => !removed.has(tag.id)).map((tag) => ({ ...tag }));
  for (const tag of add) {
    const at = next.findIndex((t) => t.id === tag.id);
    if (at === -1) next.push({ ...tag });
    else next[at] = { ...tag };
  }
  if (next.length > RUN_TAGS_MAX) throw new TaskTagError(400, `a task can carry at most ${RUN_TAGS_MAX} tags`);
  return next;
}
