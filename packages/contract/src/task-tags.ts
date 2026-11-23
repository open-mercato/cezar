import { z } from 'zod';

/**
 * Task tags (spec `.ai/specs/2026-11-23-task-tags.md`): a personal tag registry in
 * `~/.cezar/task-tags.json`, and the id-plus-snapshot each run carries. Tags are a lens — the
 * engine never reads them.
 */

export const TASK_TAG_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet'] as const;
export const TASK_TAG_NAME_MAX = 40;
export const TASK_TAG_DESCRIPTION_MAX = 280;
/** Tags on one run (D5). */
export const RUN_TAGS_MAX = 10;
/** Live registry entries; tombstones are not counted. */
export const TASK_TAGS_MAX = 500;
export const TASK_TAG_ID_RE = /^tt-[a-z0-9]{8,16}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const taskTagIdSchema = z.string().regex(TASK_TAG_ID_RE);
export const taskTagNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TASK_TAG_NAME_MAX)
  .refine((v) => !CONTROL_RE.test(v), 'tag name must not contain control characters');
export const taskTagColorSchema = z.enum(TASK_TAG_COLORS);
export type TaskTagColor = z.infer<typeof taskTagColorSchema>;
export const taskTagDescriptionSchema = z
  .string()
  .trim()
  .max(TASK_TAG_DESCRIPTION_MAX)
  .refine((v) => !CONTROL_RE.test(v.replace(/[\n\t]/g, ' ')), 'description must not contain control characters');

/** Wire shape. `projectId` absent = global. `orphaned` = scoped to a root no longer registered. */
export const taskTagSchema = z.object({
  id: taskTagIdSchema,
  name: z.string(),
  color: taskTagColorSchema.optional(),
  description: z.string().optional(),
  projectId: z.string().optional(),
  orphaned: z.literal(true).optional(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type TaskTag = z.infer<typeof taskTagSchema>;

/** On a run: id plus a display snapshot (D4). */
export const runTagSchema = z.object({
  id: taskTagIdSchema,
  name: z.string(),
  color: taskTagColorSchema.optional(),
});
export type RunTag = z.infer<typeof runTagSchema>;

/** How a caller names a tag: a known id, or a name to reuse-or-create (D6/D7). */
export const taskTagRefSchema = z.union([
  z.object({ id: taskTagIdSchema }).strict(),
  z.object({ name: taskTagNameSchema }).strict(),
]);
export type TaskTagRef = z.infer<typeof taskTagRefSchema>;

/** `GET /workspace/task-tags`. */
export const taskTagsListSchema = z.object({
  tags: z.array(taskTagSchema),
  deletedIds: z.array(z.string()),
});
export type TaskTagsList = z.infer<typeof taskTagsListSchema>;

/** `POST /workspace/task-tags`. */
export const createTaskTagInputSchema = z.object({
  name: taskTagNameSchema,
  color: taskTagColorSchema.optional(),
  description: taskTagDescriptionSchema.optional(),
  projectId: z.string().min(1).max(200).optional(),
});
export type CreateTaskTagInput = z.input<typeof createTaskTagInputSchema>;

/** `PATCH /workspace/task-tags/:tagId` — a field applies only when the body names it. */
export const patchTaskTagInputSchema = z
  .object({
    name: taskTagNameSchema.optional(),
    color: taskTagColorSchema.nullable().optional(),
    description: taskTagDescriptionSchema.nullable().optional(),
    global: z.literal(true).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'name at least one field to change' });
export type PatchTaskTagInput = z.input<typeof patchTaskTagInputSchema>;

export const taskTagParamSchema = z.object({ tagId: taskTagIdSchema });

/** `POST /workspace/task-tags` (201) and `PATCH …/:tagId`. */
export const taskTagResponseSchema = z.object({ tag: taskTagSchema });
/** `DELETE /workspace/task-tags/:tagId`. */
export const deleteTaskTagResponseSchema = z.object({ deleted: z.literal(true) });

/** `POST /runs/:id/tags` — a delta, never a whole-list replacement (D8). */
export const runTagsDeltaInputSchema = z
  .object({
    add: z.array(taskTagRefSchema).max(RUN_TAGS_MAX).optional(),
    remove: z.array(taskTagIdSchema).max(RUN_TAGS_MAX * 4).optional(),
  })
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, { message: 'name at least one tag to add or remove' });
export type RunTagsDeltaInput = z.input<typeof runTagsDeltaInputSchema>;

export const runTagsResponseSchema = z.object({ tags: z.array(runTagSchema) });
export type RunTagsResponse = z.infer<typeof runTagsResponseSchema>;
