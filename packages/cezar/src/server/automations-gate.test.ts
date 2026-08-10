import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, startServer, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * GitHub automations are opt-in (#801): `CEZ_AUTOMATIONS=1` turns them on, off is the default.
 * Off, every route of the family answers `409` naming the flag — defense in depth behind the
 * cockpit's nav gate, so a bookmarked deep link or a script cannot drive a feature the operator
 * switched off.
 *
 * The twin of `inbox-gate.test.ts`, with one deliberate difference. The inbox READER degrades to
 * `200 []` because an inbox that is off is honestly empty; an automations reader cannot say the
 * same — `{automations: []}` would read as "you have configured none", and the cockpit would then
 * offer to create one against a `409`ing POST. Off means refused, uniformly, for reads too.
 *
 * The definitions on disk are never touched: the gate hides the feature, it does not delete it.
 */

const DEFINITION = {
  name: 'Review new issues',
  enabled: false as const,
  events: ['issue.opened' as const],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
};

describe('automations gate (#801)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let automationId: string;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-automations-gate-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    // A pre-existing definition, written while the feature was on: the gate must hide it and
    // must never destroy it.
    const seed = AutomationStore.open(dataDir);
    automationId = seed.create(DEFINITION).id;
    delete process.env.CEZ_AUTOMATIONS;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  describe('off (the default)', () => {
    /** Every route of the feature, in the spelling BACKWARD_COMPATIBILITY.md §2 inventories. */
    const routes = (id: string): Array<[label: string, path: string, init?: RequestInit]> => [
      ['GET /automations', '/api/v1/automations'],
      ['POST /automations', '/api/v1/automations', json(DEFINITION)],
      ['GET /automations/:id', `/api/v1/automations/${id}`],
      ['PUT /automations/:id', `/api/v1/automations/${id}`, json({ ...DEFINITION, revision: 1 }, 'PUT')],
      ['DELETE /automations/:id', `/api/v1/automations/${id}`, { method: 'DELETE' }],
      ['POST /automations/:id/enable', `/api/v1/automations/${id}/enable`, json({ revision: 1 })],
      ['POST /automations/:id/pause', `/api/v1/automations/${id}/pause`, json({ revision: 1 })],
      ['POST /automations/:id/check', `/api/v1/automations/${id}/check`, json({ mode: 'preview' })],
      ['GET /automation-log', '/api/v1/automation-log'],
      ['POST /automation-log/:receiptId/retry', '/api/v1/automation-log/no-such-receipt/retry', { method: 'POST' }],
      ['GET /automation-checks/:checkId', '/api/v1/automation-checks/no-such-check'],
    ];

    it.each(routes('will-be-replaced').map(([label]) => label))(
      '%s answers 409 with a reason naming the flag',
      async (label) => {
        const [, path, init] = routes(automationId).find(([name]) => name === label)!;
        const res = await apiRequest(app(), path, init);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS');
      },
    );

    // The regression this file exists for. Both automation families are mounted with
    // `.route('/', …)` alongside a dozen unrelated sub-apps, so a guard registered as `use('*')`
    // instead of on explicit paths would 409 the ENTIRE `/api/v1` surface — including the
    // CORS-open discovery route the cockpit boots from.
    it('gates only its own family — health and its neighbours are untouched', async () => {
      const built = app();
      expect((await apiRequest(built, '/api/v1/health')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/runs')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/todos')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/workflows')).status).toBe(200);
    });

    it('gates the project-scoped mirror too, not just the boot alias', async () => {
      const res = await apiRequest(app(), '/api/v1/p/default/automations');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS');
    });

    it('hides definitions without destroying them — flipping the flag brings them back', async () => {
      await apiRequest(app(), '/api/v1/automations');
      await apiRequest(app(), `/api/v1/automations/${automationId}`, { method: 'DELETE' });
      process.env.CEZ_AUTOMATIONS = '1';
      const res = await apiRequest(app(), '/api/v1/automations');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automations: Array<{ id: string; name: string }> };
      expect(body.automations).toHaveLength(1);
      expect(body.automations[0]).toMatchObject({ id: automationId, name: DEFINITION.name });
    });

    it('reports the capability as off on health, which is what the nav gate reads', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { automations: boolean } }).capabilities.automations)
        .toBe(false);
    });
  });

  describe('on (CEZ_AUTOMATIONS=1)', () => {
    beforeEach(() => {
      process.env.CEZ_AUTOMATIONS = '1';
    });

    it('serves the real definitions', async () => {
      const res = await apiRequest(app(), '/api/v1/automations');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automations: Array<{ id: string }> };
      expect(body.automations.map((item) => item.id)).toEqual([automationId]);
    });

    it('an unknown id still 404s — the gate is not swallowing it', async () => {
      const res = await apiRequest(app(), '/api/v1/automations/nope');
      expect(res.status).toBe(404);
    });

    it('a malformed body still 400s ahead of the 404 — validator order is unchanged', async () => {
      const res = await apiRequest(app(), '/api/v1/automations/nope/check', json({ mode: 'nonsense' }));
      expect(res.status).toBe(400);
    });

    it('reports the capability as on', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { automations: boolean } }).capabilities.automations)
        .toBe(true);
    });
  });

  /**
   * The flag has to remove the BEHAVIOR, not only the UI and the API: `WorkspaceAutomationScheduler`
   * is what polls GitHub on a timer and launches runs off what it finds, and a cockpit whose
   * operator switched automations off must make no GitHub requests on their behalf.
   *
   * Asserted at `startServer`, because that is where the scheduler is wired — `createApp` never
   * constructs one. The server binds an ephemeral loopback port and is closed immediately; nothing
   * here talks to the network (`CEZ_DRY_RUN=1`) or to a real agent CLI.
   */
  describe('background scheduler', () => {
    const savedHome = process.env.CEZ_HOME;
    const savedDryRun = process.env.CEZ_DRY_RUN;
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'cez-automations-gate-home-'));
      process.env.CEZ_HOME = home;
      process.env.CEZ_DRY_RUN = '1';
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      if (savedHome === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = savedHome;
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
      vi.restoreAllMocks();
    });

    /** Boot on an ephemeral port, wait for `listening` to have run its warm-up, then close. */
    const boot = async (): Promise<void> => {
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      const server = startServer(
        { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
        0,
      );
      try {
        await new Promise<void>((resolve) => server.once('listening', () => resolve()));
        // The warm-up chain is `listProjects().then(…)`; a macrotask turn is enough for it to run
        // to the point where it either starts the scheduler or returns early.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        server.close();
      }
      expect(started).toHaveBeenCalledTimes(process.env.CEZ_AUTOMATIONS === '1' ? 1 : 0);
    };

    it('never starts polling while the flag is off', async () => {
      await boot();
    });

    it('starts once the flag is on, so the gate is the only thing holding it back', async () => {
      process.env.CEZ_AUTOMATIONS = '1';
      await boot();
    });
  });
});
