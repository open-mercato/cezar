import { Hono, type Context } from 'hono';
import {
  lifecycleListQuerySchema, lifecycleWorktreeParamSchema, lifecycleOperationParamSchema,
  startLifecycleRemovalInputSchema, lifecycleActionInputSchema, lifecycleOutputQuerySchema,
  lifecyclePreviewInputSchema,
} from '@open-mercato/cezar-contract';
import { LifecycleNotFound } from '../worktree-lifecycle/coordinator.ts';
import { LifecycleTemplateError } from '../worktree-lifecycle/templates.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';

type ProjectApiEnv = { Variables: { project: ProjectContext } };

export function lifecycleError(c: Context, error: unknown) {
  const status = error instanceof LifecycleNotFound ? 404 : error instanceof LifecycleTemplateError ? 400 : 409;
  return c.json({ error: error instanceof Error ? error.message : 'Worktree lifecycle operation could not be completed' }, status);
}

/** One chained family: validated inputs and exact response inference survive both mounts. */
export function worktreeLifecycleRoutes() {
  return new Hono<ProjectApiEnv>()
    .get('/worktree-lifecycle', queryZodValidator(lifecycleListQuerySchema), async c => {
      try { return c.json(await c.get('project').manager.lifecycle.list(c.req.valid('query'))); }
      catch (error) { return lifecycleError(c, error); }
    })
    .post('/worktree-lifecycle/preview', jsonZodValidator(lifecyclePreviewInputSchema), async c => {
      try { return c.json(await c.get('project').manager.lifecycle.preview(c.req.valid('json'))); }
      catch (error) { return lifecycleError(c, error); }
    })
    .post('/worktree-lifecycle/operations', jsonZodValidator(startLifecycleRemovalInputSchema), async c => {
      try { return c.json({ operation: await c.get('project').manager.lifecycle.startRemoval(c.req.valid('json')) }, 202); }
      catch (error) { return lifecycleError(c, error); }
    })
    .get('/worktree-lifecycle/operations/:operationId', paramZodValidator(lifecycleOperationParamSchema), async c => {
      try { return c.json({ operation: await c.get('project').manager.lifecycle.operation(c.req.valid('param').operationId) }); }
      catch (error) { return lifecycleError(c, error); }
    })
    .post('/worktree-lifecycle/operations/:operationId/actions', paramZodValidator(lifecycleOperationParamSchema), jsonZodValidator(lifecycleActionInputSchema), async c => {
      try { return c.json({ operation: await c.get('project').manager.lifecycle.action(c.req.valid('param').operationId, c.req.valid('json')) }, 202); }
      catch (error) { return lifecycleError(c, error); }
    })
    .get('/worktree-lifecycle/operations/:operationId/output', paramZodValidator(lifecycleOperationParamSchema), queryZodValidator(lifecycleOutputQuerySchema), async c => {
      const lifecycle = c.get('project').manager.lifecycle;
      try {
        const { operationId } = c.req.valid('param');
        await lifecycle.operation(operationId); // Unknown IDs must not look like empty output.
        return c.json(await lifecycle.output(operationId, c.req.valid('query')));
      } catch (error) { return lifecycleError(c, error); }
    })
    .get('/worktree-lifecycle/:worktreeId', paramZodValidator(lifecycleWorktreeParamSchema), async c => {
      try { return c.json({ worktree: await c.get('project').manager.lifecycle.detail(c.req.valid('param').worktreeId) }); }
      catch (error) { return lifecycleError(c, error); }
    });
}
