import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  cardRunIdParamSchema,
  createCardBodySchema,
  duplicateFrameworkBodySchema,
  emptyCardBodySchema,
  frameworkIdParamSchema,
  installFrameworkBodySchema,
  patchCardBodySchema,
  putProjectFrameworkBodySchema,
  rerunCardBodySchema,
  type CardRunResponse,
  type FrameworkDetailResponse,
  type FrameworkSummary,
  type FrameworksResponse,
  type RunRecord,
} from '@open-mercato/cezar-contract';
import { Hono, type Context, type TypedResponse } from 'hono';
import { parseDocument } from 'yaml';
import { loadConfig } from '../config.ts';
import { availabilitySummary, stageAvailability } from '../frameworks/availability.ts';
import { builtinInstallSource } from '../frameworks/builtins.ts';
import { CardOperationError } from '../frameworks/card-runtime.ts';
import { writeProjectFrameworkChoice } from '../frameworks/choice.ts';
import { compileFramework, resolveCardFields } from '../frameworks/compile.ts';
import { resolveProjectFramework } from '../frameworks/detect.ts';
import { dryRunInstall, installFramework, installTarget } from '../frameworks/install.ts';
import { FRAMEWORKS_SUBDIR, getFramework, listFrameworks, parseFrameworkYaml } from '../frameworks/load.ts';
import { cardForkBase, frameworkRequires, missingOnRef } from '../frameworks/requires.ts';
import { discoverLocalSkills } from '../skills.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';

type ProjectApiEnv = { Variables: { project: ProjectContext } };

export interface FrameworksRoutesDeps {
  /** Re-read per request: SDD approve is a local-machine capability (D9), like agent-config writes. */
  localHandoff: () => boolean;
  /** Who approved, for `sdd.mjs approve --by` (D9). Defaults to the repo's `git config user.name`. */
  approverName?: (repoRoot: string) => Promise<string>;
  /** Runs a built-in's pinned installer; tests stub it. Defaults to `installFramework`, or a no-op under `CEZ_DRY_RUN=1`. */
  installFramework?: typeof installFramework;
}

const FALLBACK_APPROVER = 'cezar user';

function gitUserName(repoRoot: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['config', 'user.name'], { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 }, (err, stdout) => {
      const name = err ? '' : (stdout ?? '').trim();
      resolve(name || FALLBACK_APPROVER);
    });
  });
}

/**
 * `{ run }` as a NAMED type: inlined, each card route would print a whole RunRecord into
 * `createApp`'s emitted declaration and push it past TS7056's limit. Same wire, same contract.
 */
export interface CardRunAnswer extends CardRunResponse {}
function runAnswer<S extends 200 | 201>(c: Context<ProjectApiEnv>, run: RunRecord, status: S) {
  return c.json({ run }, status) as unknown as Response & TypedResponse<CardRunAnswer, S, 'json'>;
}

/** The framework answers as NAMED types too, for the same TS7056 reason (the graph is large). */
export interface FrameworksAnswer extends FrameworksResponse {}
export interface FrameworkDetailAnswer extends FrameworkDetailResponse {}
function namedAnswer<T>(c: Context<ProjectApiEnv>, body: T) {
  return c.json(body as never) as unknown as Response & TypedResponse<T, 200, 'json'>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** A refused card operation answers its own status (404/409/422); anything else the route's default. */
const failStatus = <D extends 400 | 409>(err: unknown, fallback: D): D | CardOperationError['status'] =>
  err instanceof CardOperationError ? err.status : fallback;

/** The run behind a card route, or the 404 every card route answers for an ad-hoc run. */
function cardRun(c: Context<ProjectApiEnv>, runId: string) {
  const run = c.get('project').store.getRun(runId);
  return run?.card ? run : undefined;
}

/**
 * The `/frameworks` and `/cards` families (spec 2026-11-15-framework-board § API), one chain so
 * every route reaches `AppType`. Detection is computed per request (D6), never polled.
 */
export function frameworksRoutes(deps: FrameworksRoutesDeps) {
  const approverName = deps.approverName ?? gitUserName;
  return (
    new Hono<ProjectApiEnv>()
      .get('/frameworks', async (c) => {
        const { root, dataDir } = c.get('project');
        const [loaded, skills] = await Promise.all([listFrameworks(root, dataDir), discoverLocalSkills(root).catch(() => [])]);
        // Only a built-in with an install recipe needs the branches (one git call, per request).
        const installable = loaded.some((f) => f.source === 'builtin' && builtinInstallSource(f.id));
        const configuredBase = (await loadConfig(root)).baseBranch;
        const target = installable ? await installTarget(root, configuredBase) : null;
        // The ref POST /cards checks (no fetch here: a preview must not hit the network per request).
        const needsRef = loaded.some((f) => f.framework && frameworkRequires(f.framework).length);
        const baseRef = needsRef ? await cardForkBase(root, configuredBase, { fetch: false }) : null;
        const frameworks = await Promise.all(
          loaded.map(async (f): Promise<FrameworkSummary> => {
            const fw = f.framework;
            const recipe = f.source === 'builtin' ? builtinInstallSource(f.id) : undefined;
            return {
              id: f.id,
              name: fw?.name ?? f.id,
              ...(fw?.description !== undefined ? { description: fw.description } : {}),
              ...(fw?.provisional !== undefined ? { provisional: fw.provisional } : {}),
              source: f.source,
              ...(f.path ? { path: relative(root, f.path) } : {}),
              stages: fw ? fw.stages.map((s) => ({ id: s.id, name: s.name ?? s.id })) : [],
              ...(fw ? { availability: { ...availabilitySummary(await stageAvailability(fw, root, skills)), installable: Boolean(recipe) } } : {}),
              ...(recipe && target
                ? { install: { source: recipe.label, ref: recipe.ref.slice(0, 7), writes: [...recipe.writes], ...target } }
                : {}),
              ...(fw && baseRef && frameworkRequires(fw).length
                ? await missingOnRef(root, baseRef, frameworkRequires(fw)).then((missing) => ({ installedOnBase: missing.length === 0, baseRef, missingOnBase: missing }))
                : {}),
              ...(f.error !== undefined ? { error: f.error } : {}),
            };
          }),
        );
        return namedAnswer<FrameworksAnswer>(c, { frameworks, active: resolveProjectFramework(root, dataDir) });
      })

      .get('/frameworks/:id', paramZodValidator(frameworkIdParamSchema), async (c) => {
        const { root, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        const f = await getFramework(root, dataDir, id);
        if (!f) return c.json({ error: `unknown framework: ${id}` }, 404);
        if (!f.framework) return c.json({ error: f.error ?? `framework "${id}" is invalid` }, 422);
        const framework = f.framework;
        const graph = compileFramework(framework, { title: 'Example', brief: '', fields: resolveCardFields(framework, 'Example') });
        return namedAnswer<FrameworkDetailAnswer>(c, { framework, yaml: f.yaml, stages: await stageAvailability(framework, root), graph, source: f.source });
      })

      // Never overwrites (`wx`); the copy's `id:` is rewritten so the file name and id agree.
      .post('/frameworks/:id/duplicate', paramZodValidator(frameworkIdParamSchema), jsonZodValidator(duplicateFrameworkBodySchema), async (c) => {
        const { root, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        const { newId } = c.req.valid('json');
        const all = await listFrameworks(root, dataDir);
        const source = all.find((f) => f.id === id);
        if (!source) return c.json({ error: `unknown framework: ${id}` }, 404);
        if (!source.framework) return c.json({ error: `cannot duplicate an invalid framework: ${source.error ?? id}` }, 400);
        const dir = join(dataDir, FRAMEWORKS_SUBDIR);
        if (all.some((f) => f.id === newId) || existsSync(join(dir, `${newId}.yml`))) {
          return c.json({ error: `framework "${newId}" already exists` }, 409);
        }
        const doc = parseDocument(source.yaml);
        doc.set('id', newId);
        const yaml = String(doc);
        const parsed = parseFrameworkYaml(yaml);
        if ('error' in parsed) return c.json({ error: parsed.error }, 400);
        const path = join(dir, `${newId}.yaml`);
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(path, yaml, { encoding: 'utf8', flag: 'wx' });
        } catch (err) {
          if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
            return c.json({ error: `framework "${newId}" already exists` }, 409);
          }
          return c.json({ error: message(err) }, 500);
        }
        return c.json({ id: newId, path: relative(root, path) }, 201);
      })

      // Downloads a pinned installer and runs it in the checkout, so it is local-only like approve.
      .post('/frameworks/:id/install', paramZodValidator(frameworkIdParamSchema), jsonZodValidator(installFrameworkBodySchema, { absent: {} }), async (c) => {
        if (!deps.localHandoff()) {
          return c.json({ error: 'installing a framework is disabled in hosted mode (CEZ_REMOTE) — install it from the machine that owns the checkout' }, 409);
        }
        const { root, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        const f = await getFramework(root, dataDir, id);
        if (!f) return c.json({ error: `unknown framework: ${id}` }, 404);
        const recipe = f.source === 'builtin' ? builtinInstallSource(id) : undefined;
        if (!recipe) return c.json({ error: `${f.framework?.name ?? id} has no installer cezar can run` }, 400);
        const install = deps.installFramework ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunInstall : installFramework);
        const { commit } = c.req.valid('json');
        const baseBranch = (await loadConfig(root)).baseBranch;
        const out = await install(root, id, recipe, { commit: commit ?? false, ...(baseBranch ? { baseBranch } : {}) });
        if (!out.ok) return c.json({ error: out.error }, out.code === 'conflict' ? 409 : 502);
        return c.json({
          ok: true as const,
          changedPaths: out.changedPaths,
          committed: out.committed,
          ...(out.note !== undefined ? { note: out.note } : {}),
          output: out.output,
        });
      })

      .put('/project/framework', jsonZodValidator(putProjectFrameworkBodySchema), async (c) => {
        const { root, dataDir } = c.get('project');
        const { framework } = c.req.valid('json');
        if (framework !== null) {
          const f = await getFramework(root, dataDir, framework);
          if (!f) return c.json({ error: `unknown framework: ${framework}` }, 400);
          if (!f.framework) return c.json({ error: `framework "${framework}" is invalid: ${f.error ?? ''}` }, 400);
        }
        try {
          await writeProjectFrameworkChoice(root, framework);
        } catch (err) {
          return c.json({ error: message(err) }, 409);
        }
        return c.json({ active: resolveProjectFramework(root, dataDir) });
      })

      .post('/cards', jsonZodValidator(createCardBodySchema), async (c) => {
        const { manager } = c.get('project');
        try {
          const run = await manager.createCard(c.req.valid('json'));
          return runAnswer(c, run, 201);
        } catch (err) {
          return c.json({ error: message(err) }, failStatus(err, 400));
        }
      })

      // Registered before `/cards/:runId…` so `recheck` never reads as a run id.
      .post('/cards/recheck', jsonZodValidator(emptyCardBodySchema, { absent: {} }), (c) => {
        const { manager } = c.get('project');
        // Fire and forget: `state.command` may be slow, and the watcher reports through SSE.
        void Promise.resolve()
          .then(() => manager.recheckFrameworkState())
          .catch(() => {});
        return c.json({ ok: true as const });
      })

      .patch('/cards/:runId', paramZodValidator(cardRunIdParamSchema), jsonZodValidator(patchCardBodySchema), async (c) => {
        const { runId } = c.req.valid('param');
        if (!cardRun(c, runId)) return c.json({ error: 'not found' }, 404);
        try {
          const run = await c.get('project').manager.patchCard(runId, c.req.valid('json'));
          return runAnswer(c, run, 200);
        } catch (err) {
          return c.json({ error: message(err) }, failStatus(err, 409));
        }
      })

      .post('/cards/:runId/rerun', paramZodValidator(cardRunIdParamSchema), jsonZodValidator(rerunCardBodySchema), async (c) => {
        const { runId } = c.req.valid('param');
        if (!cardRun(c, runId)) return c.json({ error: 'not found' }, 404);
        try {
          const run = await c.get('project').manager.rerunCard(runId, c.req.valid('json').fromStage);
          return runAnswer(c, run, 200);
        } catch (err) {
          return c.json({ error: message(err) }, failStatus(err, 409));
        }
      })

      .post('/cards/:runId/finish-stage', paramZodValidator(cardRunIdParamSchema), jsonZodValidator(emptyCardBodySchema, { absent: {} }), async (c) => {
        const { runId } = c.req.valid('param');
        if (!cardRun(c, runId)) return c.json({ error: 'not found' }, 404);
        try {
          await c.get('project').manager.finishStage(runId);
          return c.json({ ok: true as const });
        } catch (err) {
          return c.json({ error: message(err) }, failStatus(err, 409));
        }
      })

      .post('/cards/:runId/approve', paramZodValidator(cardRunIdParamSchema), jsonZodValidator(emptyCardBodySchema, { absent: {} }), async (c) => {
        // Spawns the framework's approve script with its non-interactive approval set (D9), so it
        // stays a local-machine capability and is re-gated on every request.
        if (!deps.localHandoff()) {
          return c.json(
            { error: 'approving a framework gate is disabled in hosted mode (CEZ_REMOTE) — approve it from the machine that owns the checkout' },
            409,
          );
        }
        const { runId } = c.req.valid('param');
        if (!cardRun(c, runId)) return c.json({ error: 'not found' }, 404);
        const { root, manager } = c.get('project');
        try {
          const out = await manager.approveCardGate(runId, await approverName(root));
          if (!out.ok) return c.json({ error: out.error }, 422);
          return c.json({ ok: true as const });
        } catch (err) {
          return c.json({ error: message(err) }, failStatus(err, 409));
        }
      })
  );
}
