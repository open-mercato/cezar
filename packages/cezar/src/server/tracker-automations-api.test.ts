import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationDetailResponseSchema } from '@open-mercato/cezar-contract';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
const mocks = vi.hoisted(() => ({ driver: vi.fn(), launch: vi.fn() }));
vi.mock('./tracker/index.ts', async importOriginal => {
  const original = await importOriginal<typeof import('./tracker/index.ts')>();
  return { ...original, createTrackerService: (...args: Parameters<typeof original.createTrackerService>) => ({ ...original.createTrackerService(...args), driver: mocks.driver }) };
});
vi.mock('../automations/task-template.ts', async importOriginal => ({ ...await importOriginal<typeof import('../automations/task-template.ts')>(), launchTrackerAutomationRun: mocks.launch }));
const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
const trigger = { association, events: ['issue.status_changed'], targetStatusIds: ['todo'] };
const input = { kind: 'tracker', name: 'Tracker', trackerTrigger: trigger, task: { prompt: 'Work on {{tracker.key}}' } };
const body = (value: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
let root: string;
let store: RunStore;
let automations: AutomationStore;
let app: ReturnType<typeof createApp>;
const options = vi.fn();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tracker-automation-api-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  automations = AutomationStore.open(join(root, '.ai/cezar'));
  mocks.launch.mockReset().mockResolvedValue({ runId: 'run' });
  options.mockReset().mockResolvedValue({ events: ['issue.opened', 'issue.status_changed'], statuses: [{ id: 'todo', name: 'To Do' }], labels: [], limitations: [] });
  mocks.driver.mockReset().mockResolvedValue({ association, automationOptions: options, pollEvents: async () => ({ candidates: [], checkpoint: 'opaque', complete: true }) });
  app = createApp({ repoRoot: root, store, automationStore: automations, manager: {} as never, version: 'test' });
});
afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });
it('creates paused, round trips status IDs, edits, enables and previews without a receipt', async () => {
  const created = await apiRequest(app, '/api/v1/automations', body(input));
  expect(created.status).toBe(201);
  const { automation } = await created.json() as any;
  expect(automation).toMatchObject({ enabled: false, intervalSeconds: 1800, trackerTrigger: trigger });
  const detail = automationDetailResponseSchema.parse(await (await apiRequest(app, `/api/v1/automations/${automation.id}`)).json());
  expect(detail.automation.trackerTrigger?.targetStatusIds).toEqual(['todo']);
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}`, body({ ...input, name: 'Edited', expectedRevision: 1 }, 'PUT'))).status).toBe(200);
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}/enable`, { method: 'POST' })).status).toBe(200);
  expect(automations.state(automation.id)?.baselineAt).toBeDefined();
  const check = await (await apiRequest(app, `/api/v1/automations/${automation.id}/check`, body({ mode: 'preview' }))).json() as any;
  await vi.waitFor(async () => expect(await (await apiRequest(app, `/api/v1/automation-checks/${check.checkId}`)).json()).toMatchObject({ status: 'complete' }));
  expect(automations.receipts()).toHaveLength(0);
  expect(automations.state(automation.id)?.checkpoint).toBeUndefined();
});
it.each([
  ['prompt', { task: { prompt: 'Updated work on {{tracker.key}}' } }],
  ['status filter', { trackerTrigger: { ...trigger, targetStatusIds: [] } }],
])('preserves checkpoint progress on an enabled tracker %s edit', async (_name, edit) => {
  const { automation } = await (await apiRequest(app, '/api/v1/automations', body({ ...input, enable: true }))).json() as any;
  const advanced = { timestamp: '2026-01-02T00:00:00.000Z' };
  automations.setState(automation.id, current => ({ ...current, baselineAt: '2026-01-01T00:00:00.000Z', cursor: advanced, checkpoint: 'poll-progress' }));
  const before = automations.state(automation.id)!;
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}`, body({ ...input, ...edit, enabled: true, expectedRevision: 1 }, 'PUT'))).status).toBe(200);
  expect(automations.state(automation.id)).toEqual({ ...before, revision: 2 });
});
it.each([
  ['event', { ...trigger, events: ['issue.opened'] }],
  ['connection rotation', { ...trigger, association: { ...association, source: { ...association.source, id: 'replacement' } } }],
  ['scope', { ...trigger, association: { ...association, externalId: 'OTHER' } }],
])('rearms an enabled tracker %s edit from now and discards the incompatible checkpoint', async (_name, trackerTrigger) => {
  const { automation } = await (await apiRequest(app, '/api/v1/automations', body({ ...input, enable: true }))).json() as any;
  automations.setState(automation.id, current => ({ ...current, baselineAt: '2026-01-01T00:00:00.000Z', cursor: { timestamp: '2026-01-02T00:00:00.000Z' }, checkpoint: 'old-source-progress' }));
  mocks.driver.mockResolvedValue({ association: trackerTrigger.association, automationOptions: options });
  const beforeSave = Date.now();
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}`, body({ ...input, trackerTrigger, enabled: true, expectedRevision: 1 }, 'PUT'))).status).toBe(200);
  const state = automations.state(automation.id)!;
  expect(state.checkpoint).toBeUndefined();
  expect(Date.parse(state.baselineAt!)).toBeGreaterThanOrEqual(beforeSave);
  expect(Date.parse(state.baselineAt!)).toBeLessThanOrEqual(Date.now());
  expect(state.cursor).toEqual({ timestamp: state.baselineAt });
  expect(Date.parse(state.nextCheckAt!)).toBe(Date.parse(state.baselineAt!) + 1800_000);
  expect(state.revision).toBe(2);
});
it('does not reset progress when an identity edit loses its revision race', async () => {
  const { automation } = await (await apiRequest(app, '/api/v1/automations', body({ ...input, enable: true }))).json() as any;
  automations.setState(automation.id, current => ({ ...current, checkpoint: 'poll-progress' }));
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}`, body({ ...input, name: 'Concurrent edit', enabled: true, expectedRevision: 1 }, 'PUT'))).status).toBe(200);
  const before = automations.state(automation.id)!;
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}`, body({ ...input, trackerTrigger: { ...trigger, events: ['issue.opened'] }, enabled: true, expectedRevision: 1 }, 'PUT'))).status).toBe(409);
  expect(automations.state(automation.id)).toEqual(before);
});
it('rejects unsupported events, foreign scope and unknown status IDs', async () => {
  for (const trackerTrigger of [{ ...trigger, events: ['issue.labeled'] }, { ...trigger, association: { ...association, externalId: 'OTHER' } }, { ...trigger, targetStatusIds: ['foreign'] }]) {
    expect((await apiRequest(app, '/api/v1/automations', body({ ...input, trackerTrigger }))).status).toBe(400);
  }
});
it('returns controlled option failures on read and mutation rather than a server error', async () => {
  options.mockRejectedValue(new Error('synthetic-secret'));
  const read = await apiRequest(app, '/api/v1/tracker/automation-options');
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ available: false, code: 'unavailable' });
  const create = await apiRequest(app, '/api/v1/automations', body(input));
  expect(create.status).toBe(400);
  expect(await create.text()).not.toContain('synthetic-secret');
});
it('durably reserves retry before launch and refuses a second retry', async () => {
  const { automation } = await (await apiRequest(app, '/api/v1/automations', body(input))).json() as any;
  const candidate = { eventId: 'history:1', timestamp: new Date().toISOString(), tieBreaker: '1', provider: 'jira' as const, association, event: 'issue.status_changed' as const, issueId: '123', key: 'P-1', title: 'test', url: 'https://example.atlassian.net/browse/P-1', status: 'todo', labels: [], change: { toId: 'todo' } };
  const receipt = automations.reserveReceipt({ automationId: automation.id, revision: 1, eventId: candidate.eventId, trackerCandidate: candidate })!;
  automations.appendReceipt({ ...receipt, status: 'launch-error' });
  mocks.launch.mockImplementation(async () => {
    expect(automations.latestReceipts().get(receipt.receiptKey)?.status).toBe('reserved');
    return { runId: 'run' };
  });
  const path = `/api/v1/automation-log/${receipt.receiptId}/retry`;
  expect((await apiRequest(app, path, { method: 'POST' })).status).toBe(202);
  expect((await apiRequest(app, path, { method: 'POST' })).status).toBe(409);
  expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it.each([
  ['event', { ...trigger, events: ['issue.opened'] }],
  ['scope', { ...trigger, association: { ...association, externalId: 'OTHER' } }],
])('allows preview after a paused tracker %s edit without enabling or launching', async (_name, trackerTrigger) => {
  const { automation } = await (await apiRequest(app, '/api/v1/automations', body({ ...input, enable: true }))).json() as any;
  automations.setState(automation.id, current => ({ ...current, baselineAt: '2026-01-01T00:00:00.000Z', checkpoint: 'old-incompatible-checkpoint' }));
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}/pause`, { method: 'POST' })).status).toBe(200);
  const pollEvents = vi.fn(async (input: { checkpoint?: string }) => {
    if (input.checkpoint) throw new Error('Incompatible checkpoint');
    return { candidates: [], checkpoint: 'preview-only', complete: true };
  });
  mocks.driver.mockResolvedValue({ association: trackerTrigger.association, automationOptions: options, pollEvents });
  expect((await apiRequest(app, `/api/v1/automations/${automation.id}`, body({ ...input, trackerTrigger, enabled: false, expectedRevision: 2 }, 'PUT'))).status).toBe(200);
  expect(automations.state(automation.id)?.checkpoint).toBeUndefined();
  expect(automations.state(automation.id)?.baselineAt).toBeUndefined();
  const check = await (await apiRequest(app, `/api/v1/automations/${automation.id}/check`, body({ mode: 'preview' }))).json() as any;
  await vi.waitFor(async () => expect(await (await apiRequest(app, `/api/v1/automation-checks/${check.checkId}`)).json()).toMatchObject({ status: 'complete' }));
  expect(pollEvents).toHaveBeenCalled();
  expect(automations.get(automation.id)?.enabled).toBe(false);
  expect(mocks.launch).not.toHaveBeenCalled();
  expect(automations.state(automation.id)?.checkpoint).toBeUndefined();
});
