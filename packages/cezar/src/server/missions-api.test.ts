import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { DEFAULT_UNIT_PROMPTS, writeUnitPrompt } from '../units/prompts.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/missions` (spec 2026-09-08-units-hierarchy §Routes) — the one route that turns a
 * user's objective into the root of a unit tree.
 *
 * Structured like `start-run.test.ts`: a capturing manager stub, so what is asserted is the
 * `StartRunInput` the route composes rather than anything about the engine. Three things it must
 * get right, and each has a way of going wrong quietly:
 *
 *   - the SIZE→ROLE mapping (`army` → caesar, `squad` → centurion, `legionary` → no unit at all);
 *   - `unit.missionId === the root run's own id`, which is only knowable after creation. A
 *     mission whose root points at someone else's id is a tree the cockpit cannot group;
 *   - the ladder rung feeding `runner`/`model`, and the role prompt feeding `systemPrompt` — a
 *     root with the default system prompt is a run that has never heard of CEZ:SPAWN.
 */
describe('POST /api/v1/missions', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput[];
  const savedUnits = process.env.CEZ_UNITS;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-missions-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = [];
    process.env.CEZ_UNITS = '1';
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured.push(input);
        return store.createRun({
          title: 't',
          workflow: 'quick-task',
          task: input.task,
          runner: input.runner,
          model: input.model,
          autonomous: input.autonomous,
          steps: [],
        });
      },
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedUnits === undefined) delete process.env.CEZ_UNITS;
    else process.env.CEZ_UNITS = savedUnits;
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const start = async (body: unknown): Promise<{ id: string }> => {
    const res = await post(body);
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };

  describe('unit sizes', () => {
    it('legionary starts an ORDINARY run — no unit, no role prompt, not autonomous', async () => {
      const { id } = await start({ objective: 'fix the typo', unit: 'legionary' });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({ task: 'fix the typo' });
      // The whole promise of the size: indistinguishable from a POST /runs task.
      expect(store.getRun(id)?.unit).toBeUndefined();
    });

    it('squad starts a CENTURION root', async () => {
      const { id } = await start({ objective: 'add the endpoint', unit: 'squad' });
      expect(captured[0]?.systemPrompt).toBe(DEFAULT_UNIT_PROMPTS.centurion);
      expect(captured[0]?.autonomous).toBe(true);
      expect(store.getRun(id)?.unit).toEqual({ role: 'centurion', missionId: id });
    });

    it('army starts a CAESAR root', async () => {
      const { id } = await start({ objective: 'ship the feature', unit: 'army' });
      expect(captured[0]?.systemPrompt).toBe(DEFAULT_UNIT_PROMPTS.caesar);
      expect(store.getRun(id)?.unit).toEqual({ role: 'caesar', missionId: id });
    });

    it('the root is its own mission — missionId is the run id the route answers with', async () => {
      const { id } = await start({ objective: 'x', unit: 'army' });
      const unit = store.getRun(id)?.unit;
      expect(unit?.missionId).toBe(id);
      // The root has no parent; the field must be ABSENT rather than an empty string, because
      // the cockpit's tree groups on its presence.
      expect(unit && 'parentRunId' in unit).toBe(false);
    });
  });

  describe('the ladder', () => {
    it("dispatches the root on its own rung's runner and model", async () => {
      await start({
        objective: 'x',
        unit: 'army',
        ladder: { caesar: { runner: 'codex', model: 'gpt-5' }, centurion: { runner: 'claude' } },
      });
      expect(captured[0]).toMatchObject({ runner: 'codex', model: 'gpt-5' });
    });

    it('persists the WHOLE ladder on the root, not just its own rung', async () => {
      // The rungs below are what the engine reads when it spawns children; dropping them here
      // would leave every child on the project default.
      const ladder = { caesar: { runner: 'claude' as const }, centurion: { model: 'haiku' } };
      const { id } = await start({ objective: 'x', unit: 'army', ladder });
      expect(store.getRun(id)?.unit?.ladder).toEqual(ladder);
    });

    it('falls back to the project default when the rung names nothing', async () => {
      await start({ objective: 'x', unit: 'squad' });
      expect(captured[0]?.runner).toBeUndefined();
      expect(captured[0]?.model).toBeUndefined();
    });

    it('ignores the ladder for a legionary — there is no rank to place it on', async () => {
      await start({ objective: 'x', unit: 'legionary', ladder: { caesar: { runner: 'codex' } } });
      expect(captured[0]?.runner).toBeUndefined();
    });
  });

  describe('budget and constraints', () => {
    it('persists the mission budget on the root', async () => {
      const { id } = await start({ objective: 'x', unit: 'army', budgetUsd: 12.5 });
      expect(store.getRun(id)?.unit?.budgetUsd).toBe(12.5);
    });

    it('persists the mission’s own resource limits on the root, and only when given', async () => {
      const { id } = await start({ objective: 'x', unit: 'army', parallel: 8, maxChildren: 6 });
      expect(store.getRun(id)?.unit?.resources).toEqual({ parallel: 8, maxChildren: 6 });
      const plain = await start({ objective: 'x', unit: 'army' });
      const unit = store.getRun(plain.id)?.unit;
      expect(unit && 'resources' in unit).toBe(false);
    });

    it('writes the mission brief into the mission directory with the objective and limits', async () => {
      const { id } = await start({ objective: 'Ship the thing', unit: 'army', constraints: ['never touch billing'], budgetUsd: 12, parallel: 4 });
      const brief = readFileSync(join(repoRoot, '.ai/cezar/missions', id, 'brief.md'), 'utf8');
      expect(brief).toContain('Ship the thing');
      expect(brief).toContain('- never touch billing');
      expect(brief).toContain('up to 4 at once');
      expect(brief).toContain('$12.00');
    });

    it('leaves budgetUsd ABSENT when none was given, rather than writing a zero', async () => {
      // A 0 budget would read as "no money left" to every brake in the engine.
      const { id } = await start({ objective: 'x', unit: 'army' });
      const unit = store.getRun(id)?.unit;
      expect(unit && 'budgetUsd' in unit).toBe(false);
    });

    it('appends constraints to the task as a readable block', async () => {
      await start({
        objective: 'ship it',
        unit: 'squad',
        constraints: ['no new dependencies', '  ', 'keep the API stable'],
      });
      expect(captured[0]?.task).toBe(
        'ship it\n\n## Constraints\n- no new dependencies\n- keep the API stable',
      );
    });

    it('leaves the task untouched when no constraint survives trimming', async () => {
      await start({ objective: 'ship it', unit: 'squad', constraints: ['   '] });
      expect(captured[0]?.task).toBe('ship it');
    });
  });

  describe('the role prompt', () => {
    it('uses the repository override when one exists', async () => {
      await writeUnitPrompt(repoRoot, 'centurion', 'You are OUR centurion.');
      await start({ objective: 'x', unit: 'squad' });
      expect(captured[0]?.systemPrompt).toBe('You are OUR centurion.');
    });
  });

  describe('rejections', () => {
    it('400s a body with no objective, and starts nothing', async () => {
      const res = await post({ unit: 'army' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('objective');
      expect(captured).toHaveLength(0);
      expect(store.listRuns()).toHaveLength(0);
    });

    it('400s an unknown unit size', async () => {
      expect((await post({ objective: 'x', unit: 'legion' })).status).toBe(400);
    });

    it('400s a negative budget and an over-long constraint', async () => {
      expect((await post({ objective: 'x', unit: 'army', budgetUsd: -1 })).status).toBe(400);
      expect((await post({ objective: 'x', unit: 'army', constraints: ['y'.repeat(401)] })).status).toBe(400);
    });

    it('400s an objective past the 100k cap — the same bound POST /runs applies', async () => {
      expect((await post({ objective: 'x'.repeat(100_001), unit: 'army' })).status).toBe(400);
    });

    it('409s a ladder model override on a models-locked repository', async () => {
      writeFileSync(join(repoRoot, '.ai', 'cezar', 'config.json'), JSON.stringify({ modelsLocked: true }), 'utf8');
      const res = await post({ objective: 'x', unit: 'army', ladder: { caesar: { model: 'opus' } } });
      expect(res.status).toBe(409);
      expect(captured).toHaveLength(0);
      // A runner choice is still allowed, exactly as on POST /runs.
      expect((await post({ objective: 'x', unit: 'army', ladder: { caesar: { runner: 'codex' } } })).status)
        .toBe(201);
    });
  });
});
