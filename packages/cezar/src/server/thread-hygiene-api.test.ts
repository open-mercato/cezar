import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { seedHandoffFile, handoffPath } from '../handoff.ts';
import { threadStatusSchema } from '@open-mercato/cezar-contract';

describe('saved thread status', () => {
  let root: string;
  let store: RunStore;
  let home: string;
  const originalHome = process.env.CEZ_HOME;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cez-thread-home-')); process.env.CEZ_HOME = home; clearProjectProbeCache(); root = mkdtempSync(join(tmpdir(), 'cez-thread-status-')); store = RunStore.open(join(root, '.ai/cezar')); });
  afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); if (originalHome === undefined) delete process.env.CEZ_HOME; else process.env.CEZ_HOME = originalHome; });
  it('reads dated notes without invoking a manager or changing the record', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 'goal', steps: [] });
    const dataDir = join(root, '.ai/cezar');
    seedHandoffFile(dataDir, { ...run });
    const path = handoffPath(dataDir, run.id);
    writeFileSync(path, '# Saved result\n\n## Resume notes\nNext: accepted early mockup.');
    const manager = new Proxy({}, { get: () => { throw new Error('Status must not invoke an agent operation'); } }) as RunManager;
    const app = createApp({ repoRoot: root, store, manager, version: 'test' });
    const before = JSON.stringify(store.getRun(run.id));
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/thread-status`);
    expect(response.status).toBe(200);
    const status = threadStatusSchema.parse(await response.json());
    expect(status.contentUpdatedAt).toBe(statSync(path).mtime.toISOString());
    expect(status.handoff).toContain('accepted early mockup');
    expect(JSON.stringify(store.getRun(run.id))).toBe(before);
    expect(readFileSync(path, 'utf8')).toBe(status.handoff);
  });
  it('missing notes and pre-tracking history are reported as unknown', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 'goal', steps: [] });
    store.updateRun(run.id, { threadHygiene: undefined });
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/thread-status`);
    expect(await response.json()).toMatchObject({ contentUpdatedAt: null, continuations: null, historyKnown: false, handoff: '' });
  });
  it('a status read of a cold project never constructs its manager or recovers tasks', async () => {
    const otherRoot = join(root, 'cold-project'); mkdirSync(otherRoot);
    const boot = await registerProject(root); const other = await registerProject(otherRoot);
    const dataDir = join(otherRoot, '.ai/cezar'); mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([{ id: 'cold', title: 'Cold', task: 't', workflow: 'quick-task', status: 'running', createdAt: '2026-11-17T10:00:00Z', tokensUsed: 0, archived: false, steps: [] }]));
    const before = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    const contexts = new ProjectContexts({ listProjects });
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: boot.id, contexts });
    const response = await apiRequest(app, `/api/v1/p/${other.id}/runs/cold/thread-status`);
    expect(response.status).toBe(200); expect(contexts.peek(other.id)).toBeUndefined(); expect(contexts.ids()).toEqual([]);
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(before);
    contexts.disposeAll();
  });

});
