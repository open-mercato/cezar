import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { automationDefinitionSchema, automationsResponseSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { RunStore } from '../runs/store.ts';
import { AutomationStore } from '../automations/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const dirs: string[] = [];
const stores: RunStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.flush()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cez1818-api-')); dirs.push(root);
  const data = join(root, '.ai/cezar'); mkdirSync(data, { recursive: true });
  const store = RunStore.open(data); stores.push(store);
  return { app: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' }), data };
}
const schedules = [{ type: 'weekdays', hour: 9 }, { type: 'weekly', day: 5, hour: 16 }];
const input = { kind: 'schedule', name: 'Shared checks', schedules, task: { prompt: 'Check the repo' } };
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('#1818 HTTP boundary', () => {
  it('accepts list-only POST, serves it through aliases, and replaces it on old-client PUT', async () => {
    const { app, data } = setup();
    const response = await apiRequest(app, '/api/v1/automations', json(input));
    expect(response.status).toBe(201);
    const created = z.object({ automation: automationDefinitionSchema }).parse(await response.json()).automation;
    expect(created).toMatchObject({ schedule: schedules[0], schedules });
    const listed = automationsResponseSchema.parse(await (await apiRequest(app, '/api/v1/p/default/automations')).json());
    expect(listed.automations[0]?.schedules).toEqual(schedules);
    const store = AutomationStore.open(data);
    store.setState(created.id, () => ({ nextRunAt: '2030-01-01T00:00:00.000Z' }));
    const edited = await apiRequest(app, `/api/v1/automations/${created.id}`, json({ ...input, schedules: [schedules[0], { ...schedules[1], hour: 8 }], expectedRevision: created.revision }, 'PUT'));
    expect(edited.status).toBe(200);
    expect(store.state(created.id)?.nextRunAt).toBeUndefined();
    store.setState(created.id, () => ({ nextRunAt: '2030-01-01T00:00:00.000Z' }));
    const updated = await apiRequest(app, `/api/v1/automations/${created.id}`, json({ name: input.name, kind: 'schedule', schedule: { type: 'daily', hour: 6 }, task: input.task, expectedRevision: created.revision + 1 }, 'PUT'));
    expect(updated.status).toBe(200);
    expect(z.object({ automation: automationDefinitionSchema }).parse(await updated.json()).automation.schedules).toBeUndefined();
    expect(store.get(created.id)?.schedules).toBeUndefined();
    expect(store.state(created.id)?.nextRunAt).toBeUndefined();
  });
  it('rejects over-bound, empty, mixed, mismatched and event-kind schedule lists', async () => {
    const { app } = setup();
    for (const body of [
      { ...input, schedules: [] }, { ...input, schedules: Array(17).fill(schedules[0]) },
      { ...input, schedules: [schedules[0], { type: 'once', date: '2030-01-01' }] },
      { ...input, schedule: { type: 'daily', hour: 5 } },
      { ...input, kind: 'github', events: ['issue.opened'], filters: {}, intervalSeconds: 300 },
      { ...input, schedules: [{ type: 'once' }] },
    ]) expect((await apiRequest(app, '/api/v1/automations', json(body))).status).toBe(400);
  });
});
