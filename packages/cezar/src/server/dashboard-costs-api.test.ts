import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { dashboardCostsSchema, dashboardSnapshotSchema, dashboardTasksPageSchema, dashboardFeedSchema } from '@open-mercato/cezar-contract';
import { DashboardReader } from '../workspace/dashboard.ts';
import { dashboardRoutes } from './dashboard.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it('reads raw cold records without writes, validates queries and reapplies current policy to pages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-costs-'));
  roots.push(root);
  const dir = join(root, '.ai/cezar');
  mkdirSync(dir, { recursive: true });
  const records = Array.from({ length: 225 }, (_, i) => ({
    id: `task-${i}`,
    title: `Task ${i}`,
    workflow: 'build',
    task: 'secret',
    status: 'done',
    createdAt: 'invalid date',
    archived: i % 2 === 0,
    tokensUsed: 9000,
    inputTokens: i,
    costUsd: i,
    steps: [],
  }));
  const zero = {
    ...records[0]!,
    id: 'historical-zero',
    costUsd: undefined,
    inputTokens: undefined,
    steps: [
      {
        id: 's',
        name: 'Step',
        kind: 'agent',
        status: 'done',
        iterations: 1,
        tokensUsed: 0,
        costUsd: 0,
      },
    ],
  };
  const stored = [...records, zero];
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(stored));
  const before = readFileSync(join(dir, 'runs.json'), 'utf8');
  const reader = new DashboardReader({
    projects: async () => [{ id: 'p', root }],
  });
  let policy = { tokens: true, cost: true };
  const app = new Hono().route(
    '/api/v1',
    dashboardRoutes(reader, () => policy),
  );
  const get = (query = '') =>
    app.request(`/api/v1/workspace/dashboard/costs${query}`);
  try {
    const response = await get();
    expect(response.status).toBe(200);
    const wire = await response.json();
    expect(dashboardCostsSchema.parse(wire)).toEqual(wire);
    const first = dashboardCostsSchema.parse(wire);
    expect(first.totals.tasks).toBe(226);
    expect(first.totals.costUsd?.value).toBe(25200);
    expect(first.tasks.rows).toHaveLength(20);
    expect(first.invalidDateTasks).toBe(226);
    const zeroPage = dashboardCostsSchema.parse(
      await (await get(`?snapshotId=${first.snapshotId}&offset=224`)).json(),
    );
    expect(
      zeroPage.tasks.rows.find((row) => row.id === 'historical-zero')?.costUsd,
    ).toBe(0);
    expect(first.tasks.rows[0]?.id).toBe('task-224');
    expect(JSON.stringify(wire)).not.toContain('secret');
    for (const query of [
      '?period=today',
      '?limit=21',
      '?offset=-1',
      '?offset=9007199254740992',
      '?sort=weighted',
    ])
      expect((await get(query)).status).toBe(400);
    for (const tokens of [true, false])
      for (const cost of [true, false]) {
        policy = { tokens, cost };
        const result = dashboardCostsSchema.parse(
          await (await get(`?snapshotId=${first.snapshotId}`)).json(),
        );
        expect('costUsd' in result.totals).toBe(cost);
        expect('inputTokens' in result.totals).toBe(tokens);
        expect('costUsd' in result.tasks.rows[0]!).toBe(cost);
        expect('inputTokens' in result.projects[0]!).toBe(tokens);
      }
    expect(
      (await get(`?snapshotId=${first.snapshotId}&period=7d`)).status,
    ).toBe(409);
    expect((await get('?snapshotId=unknown')).status).toBe(409);
    expect(
      (await app.request('/api/v1/p/p/workspace/dashboard/costs')).status,
    ).toBe(404);
    expect(readFileSync(join(dir, 'runs.json'), 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['runs.json']);
    writeFileSync(join(dir, 'runs.json'), JSON.stringify(records.slice(1)));
    expect((await get(`?snapshotId=${first.snapshotId}`)).status).toBe(409);
  } finally {
    reader.dispose();
  }
});


it('reapplies cost visibility to operational snapshots, pages and feed without mutating cached rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-policy-'));
  roots.push(root);
  const dir = join(root, '.ai/cezar');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(['review', 'done'].map((status) => ({
    id: status, title: status, workflow: 'build', task: 'private', status,
    createdAt: new Date().toISOString(), finishedAt: status === 'done' ? new Date().toISOString() : undefined,
    archived: false, tokensUsed: 0, costUsd: 42, steps: [],
  }))));
  const reader = new DashboardReader({ projects: async () => [{ id: 'p', root }] });
  let cost = true;
  const app = dashboardRoutes(reader, () => ({ cost, tokens: false }));
  const get = async (path: string) => (await app.request('/workspace/dashboard' + path)).json();
  try {
    const initial = dashboardSnapshotSchema.parse(await get(''));
    expect(initial.reviews.rows[0]!.costUsd).toBe(42);
    cost = false;
    expect(JSON.stringify(await get(''))).not.toContain('costUsd');
    const pagePath = `/tasks?snapshotId=${initial.snapshotId}&group=reviews`;
    expect(JSON.stringify(await get(pagePath))).not.toContain('costUsd');
    expect(JSON.stringify(await get('/feed?filter=tasks'))).not.toContain('costUsd');
    cost = true;
    expect(dashboardTasksPageSchema.parse(await get(pagePath)).page.rows[0]!.costUsd).toBe(42);
    const result = dashboardFeedSchema.parse(await get('/feed?filter=tasks')).rows[0]!;
    expect(result.kind === 'task-result' && result.run.costUsd).toBe(42);
  } finally { reader.dispose(); }
});
