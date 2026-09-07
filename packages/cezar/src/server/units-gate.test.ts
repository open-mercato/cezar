import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { DEFAULT_UNIT_PROMPTS, unitPromptsDir, writeUnitPrompt } from '../units/prompts.ts';
import { createApp, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * Units are opt-in (spec 2026-09-08-units-hierarchy, Q1): `CEZ_UNITS=1` turns them on, off is
 * the default. Off, every route of the family answers `409` naming the flag — defense in depth
 * behind the cockpit's nav gate, so a bookmarked deep link or a script cannot start a mission on
 * a server whose operator switched the feature off.
 *
 * The twin of `automations-gate.test.ts`, and it refuses reads for the same reason: an empty
 * `{prompts: []}` would read as "this server has no role prompts", and the Settings editor would
 * then offer to save one against a `409`ing PUT.
 *
 * What matters more here than in the automations gate is the LAUNCH path. Automations off means
 * nothing polls; units off has to mean nothing SPAWNS — so the assertion that a POST creates no
 * run while the flag is off is the one this file exists for.
 */
describe('units gate (CEZ_UNITS)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let started: StartRunInput[];
  const savedUnits = process.env.CEZ_UNITS;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-units-gate-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    started = [];
    delete process.env.CEZ_UNITS;
    delete process.env.CEZ_AUTOMATIONS;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedUnits === undefined) delete process.env.CEZ_UNITS;
    else process.env.CEZ_UNITS = savedUnits;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const manager = () =>
    ({
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started.push(input);
        return store.createRun({ title: 't', workflow: 'quick-task', task: input.task, steps: [] });
      },
    }) as unknown as RunManager;

  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot,
      store,
      manager: manager(),
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      ...over,
    });

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const MISSION = { objective: 'take the hill', unit: 'army' as const };

  describe('off (the default)', () => {
    /** Every route of the feature, in the spelling BACKWARD_COMPATIBILITY.md §2 inventories. */
    const routes: Array<[label: string, path: string, init?: RequestInit]> = [
      ['POST /missions', '/api/v1/missions', json(MISSION)],
      ['GET /units/prompts', '/api/v1/units/prompts'],
      ['PUT /units/prompts/:role', '/api/v1/units/prompts/caesar', json({ text: 'mine' }, 'PUT')],
      ['DELETE /units/prompts/:role', '/api/v1/units/prompts/caesar', { method: 'DELETE' }],
    ];

    it.each(routes)('%s answers 409 with a reason naming the flag', async (_label, path, init) => {
      const res = await apiRequest(app(), path, init);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_UNITS');
    });

    // The point of the gate, not merely of the 409: off has to remove the BEHAVIOR.
    it('starts no run — a refused mission must not leave one behind', async () => {
      await apiRequest(app(), '/api/v1/missions', json(MISSION));
      expect(started).toHaveLength(0);
      expect(store.listRuns()).toHaveLength(0);
    });

    it('writes no prompt file — a refused PUT must not touch the repo', async () => {
      await apiRequest(app(), '/api/v1/units/prompts/caesar', json({ text: 'mine' }, 'PUT'));
      expect(() => readdirSync(unitPromptsDir(repoRoot))).toThrow();
    });

    it('refuses before validating — a malformed body still answers the gate, not a 400', async () => {
      // Gate as MIDDLEWARE, so the refusal is uniform: a client cannot learn anything about the
      // feature's body schema from a server that has it switched off.
      const res = await apiRequest(app(), '/api/v1/missions', json({ nonsense: true }));
      expect(res.status).toBe(409);
    });

    // The regression this file shares with automations-gate: the family is mounted with
    // `.route('/', …)` alongside a dozen unrelated sub-apps, so a guard registered as `use('*')`
    // would 409 the ENTIRE `/api/v1` surface — including the CORS-open discovery route.
    it('gates only its own family — health and its neighbours are untouched', async () => {
      const built = app();
      expect((await apiRequest(built, '/api/v1/health')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/runs')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/todos')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/workflows')).status).toBe(200);
    });

    it('gates the project-scoped mirror too, not just the boot alias', async () => {
      const res = await apiRequest(app(), '/api/v1/p/default/units/prompts');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_UNITS');
    });

    it('hides an existing prompt override without destroying it', async () => {
      await writeUnitPrompt(repoRoot, 'legate', 'a prompt written while the flag was on');
      expect((await apiRequest(app(), '/api/v1/units/prompts')).status).toBe(409);
      await apiRequest(app(), '/api/v1/units/prompts/legate', { method: 'DELETE' });
      process.env.CEZ_UNITS = '1';
      const res = await apiRequest(app(), '/api/v1/units/prompts');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { prompts: Array<{ role: string; text: string; source: string }> };
      expect(body.prompts.find((p) => p.role === 'legate')).toMatchObject({
        source: 'file',
        text: 'a prompt written while the flag was on',
      });
    });

    it('reports the capability as off on health, which is what the nav gate reads', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { units: boolean } }).capabilities.units).toBe(false);
    });
  });

  describe('on (CEZ_UNITS=1)', () => {
    beforeEach(() => {
      process.env.CEZ_UNITS = '1';
    });

    it('serves the shipped role prompts', async () => {
      const res = await apiRequest(app(), '/api/v1/units/prompts');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { prompts: Array<{ role: string; text: string; source: string }> };
      expect(body.prompts.map((p) => p.role)).toEqual(['caesar', 'legate', 'centurion']);
      expect(body.prompts[0]?.text).toBe(DEFAULT_UNIT_PROMPTS.caesar);
    });

    it('starts a mission', async () => {
      const res = await apiRequest(app(), '/api/v1/missions', json(MISSION));
      expect(res.status).toBe(201);
      expect(started).toHaveLength(1);
    });

    it('an unknown role still 400s — the gate is not swallowing it', async () => {
      const res = await apiRequest(app(), '/api/v1/units/prompts/emperor', json({ text: 'x' }, 'PUT'));
      expect(res.status).toBe(400);
    });

    it('a malformed body still 400s — validator order is unchanged', async () => {
      expect((await apiRequest(app(), '/api/v1/missions', json({ unit: 'army' }))).status).toBe(400);
    });

    it('reports the capability as on', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { units: boolean } }).capabilities.units).toBe(true);
    });
  });
});
