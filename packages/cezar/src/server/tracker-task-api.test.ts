import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
const ops = vi.hoisted(() => ({ trackerTaskContext: vi.fn(), executeTrackerOperation: vi.fn() }));
vi.mock('./tracker/task-access.ts', () => ops);
let root: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
const binding = { provider: 'jira', issueId: '101' };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tracker-task-api-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  app = createApp({ repoRoot: root, store, manager: { trackerTaskForCapability: (token: string) => token === 'allowed' ? { id: 'bound-run', automationTracker: binding } : undefined } as never, version: 'test' });
});
afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); vi.resetAllMocks(); });
it('rejects missing/forged task authorization before reading or writing the tracker', async () => {
  expect((await apiRequest(app, '/api/v1/tracker/task')).status).toBe(403);
  expect((await apiRequest(app, '/api/v1/tracker/task', { headers: { Authorization: 'Bearer forged' } })).status).toBe(403);
  expect(ops.trackerTaskContext).not.toHaveBeenCalled();
});
it('validates the action as middleware and never accepts a client-selected issue', async () => {
  const body = { operationId: '11111111-1111-4111-8111-111111111111', action: { kind: 'comment', body: 'Ready' } };
  const request = (value: unknown) => apiRequest(app, '/api/v1/tracker/task', { method: 'POST', headers: { Authorization: 'Bearer allowed', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  expect((await request({ ...body, issueId: 'other' })).status).toBe(400);
  ops.executeTrackerOperation.mockResolvedValue({ operationId: body.operationId, status: 'completed', message: 'Confirmed' });
  expect((await request(body)).status).toBe(200);
  expect(ops.executeTrackerOperation).toHaveBeenCalledWith(root, join(root, '.ai/cezar'), 'bound-run', binding, body, expect.any(Function));
});
