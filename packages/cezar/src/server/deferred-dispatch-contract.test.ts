import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationDetailResponseSchema, automationResponseSchema, automationListEntrySchema,
  automationTaskSchema, createAutomationInputSchema, updateAutomationInputSchema,
  automationTemplateSchema,
} from '@open-mercato/cezar-contract';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';

const dispatch = { maxSubtasks: 3, inFlight: 1, budgetUsd: 5, runner: 'codex', model: 'gpt-5' };
const json = (body: unknown, method = 'POST') => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('deferred dispatch response contract', () => {
  let root: string, store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-deferred-contract-'));
    mkdirSync(join(root, 'profile'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'profile'));
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    vi.stubEnv('CEZ_DRY_RUN', '1');
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('roundtrips a parsed deferred definition through rescheduling without losing dispatch intent', async () => {
    const startRun = vi.fn(() => { throw new Error('must not launch'); });
    const api = createApp({ repoRoot: root, store, manager: { startRun } as unknown as RunManager, version: 'test' });
    const body = {
      task: { task: 'Later', workflow: 'quick-task', runner: 'claude', dispatch },
      start: { kind: 'at', date: '2099-01-01', hour: 9, minute: 0 },
    };
    const previewResponse = await apiRequest(api, '/api/v1/deferred-start/preview', json(body));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { available: boolean; previewRevision: string };
    expect(preview.available).toBe(true);
    const created = await apiRequest(api, '/api/v1/deferred-start', json({
      ...body, previewRevision: preview.previewRevision, idempotencyKey: randomUUID(),
    }));
    expect(created.status).toBe(201);
    const creation = await created.json() as { scheduled: { id: string } };
    const path = '/api/v1/automations/' + creation.scheduled.id;
    const detail = await apiRequest(api, path);
    expect(detail.status).toBe(200);
    const raw = await detail.json();
    const { automation } = automationDetailResponseSchema.parse(raw);
    const rescheduled = await apiRequest(api, path, json({
      expectedRevision: automation.revision, name: automation.name, kind: automation.kind,
      task: automation.task, schedule: { type: 'once', date: '2099-01-02', hour: 9, minute: 0 },
      enabled: true,
    }, 'PUT'));
    expect(rescheduled.status, await rescheduled.clone().text()).toBe(200);
    expect(automation.task.dispatch).toEqual(dispatch);
    const updated = automationResponseSchema.parse(await rescheduled.json()).automation;
    expect(updated.task.dispatch).toEqual(dispatch);
    expect(updated.schedule).toMatchObject({ date: '2099-01-02' });
    expect(updated.revision).toBe(automation.revision + 1);
    // The list uses the same definition shape; no forge availability probe is needed here.
    expect(automationListEntrySchema.parse({
      ...updated, counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 }, runs7d: 0,
    }).task.dispatch).toEqual(dispatch);
    expect(startRun).not.toHaveBeenCalled();
    expect(store.listRuns()).toEqual([]);
  });

  it('preserves ordinary automation dispatch without adding composer-only editable fields', () => {
    const ordinary = { maxSubtasks: 3, reviewChild: true };
    const task = { prompt: 'Review', dispatch: { ...dispatch, reviewChild: true } };
    const definition = { name: 'Ordinary', kind: 'schedule', task, schedule: { type: 'daily', hour: 9, minute: 0 } };
    expect(automationTaskSchema.parse(task).dispatch).toEqual(ordinary);
    expect(createAutomationInputSchema.parse(definition).task.dispatch).toEqual(ordinary);
    expect(updateAutomationInputSchema.parse({ ...definition, expectedRevision: 1 }).task.dispatch).toEqual(ordinary);
    expect(automationTemplateSchema.parse({
      ...definition, id: 'ordinary', project: { id: 'default', name: 'Project' },
    }).task.dispatch).toEqual(ordinary);
    expect(automationResponseSchema.parse({
      automation: { ...definition, task: { ...task, dispatch: ordinary }, id: 'ordinary',
        enabled: false, revision: 1, createdAt: 'now', updatedAt: 'now' },
    }).automation.task.dispatch).toEqual(ordinary);
  });
});
