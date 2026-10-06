import { Hono } from 'hono';
import { runIdParamSchema, shadowIntentParamSchema } from '@open-mercato/cezar-contract';
import type { ProjectContext } from '../server/project-context.ts';
import { paramZodValidator } from '../server/validators.ts';
import { discardShadowIntent, promoteShadowIntent, type PromoteContext } from './promote.ts';
import { buildShadowLedger } from './view.ts';

/**
 * The SHADOW family (spec `2026-10-06-shadow-runs` § API Contracts), project-scoped: chained into
 * the `v1` table in `server.ts` with one `.route('/', shadowRoutes())`, so it answers under both
 * `/api/v1/runs/:id/shadow…` and `/api/v1/p/:projectId/runs/:id/shadow…` and reaches `AppType`.
 *
 * Both path params are validated as middleware (AGENTS.md § The HTTP API) - `:intentId` ends up
 * compared against ledger ids, never joined into a path, but it is shape-checked first anyway.
 */

type ShadowRoutesEnv = { Variables: { project: ProjectContext } };

export interface ShadowRouteDeps {
  /** The promotion's command runner, gh lookup and git - tests only. */
  promote?: Pick<PromoteContext, 'exec' | 'findGh' | 'git'>;
}

export function shadowRoutes(deps: ShadowRouteDeps = {}) {
  const contextFor = (project: ProjectContext, runId: string, worktreePath: string | undefined): PromoteContext => ({
    dataDir: project.dataDir,
    runId,
    repoRoot: project.root,
    ...(worktreePath ? { worktreePath } : {}),
    ...deps.promote,
  });

  return new Hono<ShadowRoutesEnv>()
    .get('/runs/:id/shadow', paramZodValidator(runIdParamSchema), async (c) => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const run = project.store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.json(await buildShadowLedger(contextFor(project, run.id, run.worktreePath), run.shadow === true));
    })

    .post('/runs/:id/shadow/intents/:intentId/promote', paramZodValidator(shadowIntentParamSchema), async (c) => {
      const project = c.get('project');
      const { id, intentId } = c.req.valid('param');
      const run = project.store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (run.shadow !== true) return c.json({ error: 'not a shadow run' }, 409);
      const outcome = await promoteShadowIntent(contextFor(project, run.id, run.worktreePath), intentId);
      if (!outcome.ok) {
        return c.json({ error: outcome.error, ...(outcome.manual !== undefined ? { manual: outcome.manual } : {}) }, outcome.status);
      }
      project.store.appendEvent(id, { type: 'note', message: `shadow: promoted ${outcome.intent.summary}` });
      return c.json({ promoted: true as const, intent: outcome.intent });
    })

    .post('/runs/:id/shadow/intents/:intentId/discard', paramZodValidator(shadowIntentParamSchema), async (c) => {
      const project = c.get('project');
      const { id, intentId } = c.req.valid('param');
      const run = project.store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (run.shadow !== true) return c.json({ error: 'not a shadow run' }, 409);
      const outcome = await discardShadowIntent(contextFor(project, run.id, run.worktreePath), intentId);
      if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
      project.store.appendEvent(id, { type: 'note', message: `shadow: discarded ${outcome.intent.summary}` });
      return c.json({ discarded: true as const, intent: outcome.intent });
    });
}
