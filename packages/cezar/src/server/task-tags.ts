import { Hono, type Context } from 'hono';
import {
  createTaskTagInputSchema,
  patchTaskTagInputSchema,
  runTagsDeltaInputSchema,
  taskTagParamSchema,
} from '@open-mercato/cezar-contract';
import {
  applyRunTagDelta,
  createTaskTag,
  deleteTaskTag,
  listTaskTags,
  loadTaskTags,
  mergeWriteTaskTags,
  resolveTagRefs,
  TaskTagError,
  TaskTagWriteError,
  toWireTaskTag,
  updateTaskTag,
  type StoredTaskTag,
} from '../workspace/task-tags.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';

type ProjectApiEnv = { Variables: { project: ProjectContext } };

export interface TaskTagRouteDeps {
  /** Every project the wire can name, with its realpath'd root — the registry plus the boot project. */
  projectRoots: () => Promise<ReadonlyArray<{ id: string; root: string }>>;
}

/** Map a registry refusal or a failed write to the route's `{ error }` answer. */
export function taskTagError(c: Context, error: unknown) {
  if (error instanceof TaskTagError) return c.json({ error: error.message }, error.status);
  if (error instanceof TaskTagWriteError) return c.json({ error: error.message }, 500);
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

async function rootIndex(deps: TaskTagRouteDeps) {
  const projects = await deps.projectRoots().catch(() => []);
  const byRoot = new Map<string, string>();
  for (const p of projects) if (p.id !== 'default' && !byRoot.has(p.root)) byRoot.set(p.root, p.id);
  return {
    idForRoot: (root: string) => byRoot.get(root),
    rootFor: (projectId: string) => projects.find((p) => p.id === projectId)?.root,
  };
}

/** Workspace-level, single-mount (spec 2026-11-23-task-tags § 5). */
export function taskTagsWorkspaceRoutes(deps: TaskTagRouteDeps) {
  return new Hono()
    .get('/workspace/task-tags', async (c) => {
      const [store, index] = await Promise.all([loadTaskTags(), rootIndex(deps)]);
      return c.json(listTaskTags(store, index.idForRoot), 200);
    })
    .post('/workspace/task-tags', jsonZodValidator(createTaskTagInputSchema), async (c) => {
      const body = c.req.valid('json');
      const index = await rootIndex(deps);
      let projectRoot: string | null = null;
      if (body.projectId !== undefined) {
        const root = index.rootFor(body.projectId);
        if (root === undefined) return c.json({ error: `unknown project: ${body.projectId}` }, 404);
        projectRoot = root;
      }
      let created: StoredTaskTag | undefined;
      try {
        await mergeWriteTaskTags((store) => {
          created = createTaskTag(store, {
            name: body.name,
            ...(body.color !== undefined ? { color: body.color } : {}),
            ...(body.description ? { description: body.description } : {}),
            projectRoot,
          });
        });
      } catch (error) {
        return taskTagError(c, error);
      }
      return c.json({ tag: toWireTaskTag(created!, index.idForRoot) }, 201);
    })
    .patch(
      '/workspace/task-tags/:tagId',
      paramZodValidator(taskTagParamSchema),
      jsonZodValidator(patchTaskTagInputSchema),
      async (c) => {
        const { tagId } = c.req.valid('param');
        const body = c.req.valid('json');
        const index = await rootIndex(deps);
        let updated: StoredTaskTag | undefined;
        try {
          await mergeWriteTaskTags((store) => {
            updated = updateTaskTag(store, tagId, body);
          });
        } catch (error) {
          return taskTagError(c, error);
        }
        return c.json({ tag: toWireTaskTag(updated!, index.idForRoot) }, 200);
      },
    )
    .delete('/workspace/task-tags/:tagId', paramZodValidator(taskTagParamSchema), async (c) => {
      const { tagId } = c.req.valid('param');
      try {
        await mergeWriteTaskTags((store) => deleteTaskTag(store, tagId));
      } catch (error) {
        return taskTagError(c, error);
      }
      return c.json({ deleted: true as const }, 200);
    });
}

/** Project-scoped: `POST /runs/:id/tags`, mounted under both prefixes. */
export function runTagsRoutes() {
  return new Hono<ProjectApiEnv>().post('/runs/:id/tags', jsonZodValidator(runTagsDeltaInputSchema), async (c) => {
    const { store, root } = c.get('project');
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
    const body = c.req.valid('json');
    let added: Awaited<ReturnType<typeof resolveTagRefs>>['tags'];
    try {
      // Resolve FIRST — it may write the registry and await. Only then read the run's tags and
      // write the delta with no await in between, so concurrent edits compose (D8).
      added = (await resolveTagRefs(body.add ?? [], root)).tags;
    } catch (error) {
      return taskTagError(c, error);
    }
    const run = store.getRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    let next;
    try {
      next = applyRunTagDelta(run.tags, added, body.remove ?? []);
    } catch (error) {
      return taskTagError(c, error);
    }
    store.updateRun(id, { tags: next.length > 0 ? next : undefined });
    return c.json({ tags: next }, 200);
  });
}
