import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foldReportedModel, foldRunModels, sameModel } from './reported-model.ts';
import { RunStore } from './store.ts';

describe('foldReportedModel', () => {
  it('takes the main model from session.started', () => {
    expect(foldReportedModel({}, { type: 'session.started', model: 'claude-opus-5-5' })).toEqual({
      actualModel: 'claude-opus-5-5',
      modelsUsed: [{ model: 'claude-opus-5-5' }],
    });
    expect(foldReportedModel({}, { type: 'session.started' })).toBeUndefined();
  });

  it('keeps the init model as main and adds every modelUsage share, summed across turns', () => {
    let step = foldReportedModel({}, { type: 'session.started', model: 'claude-opus-5-5[1m]' })!;
    const turn = {
      type: 'turn.completed',
      models: [
        { model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
        { model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
      ],
    };
    step = foldReportedModel(step, turn)!;
    step = foldReportedModel(step, turn)!;
    expect(step).toEqual({
      actualModel: 'claude-opus-5-5[1m]',
      modelsUsed: [
        { model: 'claude-opus-5-5[1m]', inputTokens: 200, outputTokens: 40, costUsd: 1 },
        { model: 'claude-haiku-5-5', inputTokens: 20, outputTokens: 4, costUsd: 0.02 },
      ],
    });
  });

  it('picks the costliest share as main when no session named one', () => {
    const step = foldReportedModel({}, {
      type: 'turn.completed',
      models: [
        { model: 'claude-haiku-5-5', costUsd: 0.01 },
        { model: 'claude-sonnet-5-5', costUsd: 0.2 },
      ],
    });
    expect(step?.actualModel).toBe('claude-sonnet-5-5');
  });

  it('a later session on another model replaces the main one and keeps the earlier in the list', () => {
    let step = foldReportedModel({}, { type: 'session.started', model: 'claude-sonnet-5-5' })!;
    step = foldReportedModel(step, { type: 'session.started', model: 'claude-opus-5-5' })!;
    expect(step.actualModel).toBe('claude-opus-5-5');
    expect(step.modelsUsed?.map((entry) => entry.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(foldRunModels({}, step)).toEqual({ actualModel: 'claude-opus-5-5', modelsUsed: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
  });

  it('ignores malformed shares and unrelated events', () => {
    expect(foldReportedModel({}, { type: 'turn.completed', models: [{ model: '' }, { nope: 1 }, 'x'] })).toBeUndefined();
    expect(foldReportedModel({}, { type: 'turn.completed' })).toBeUndefined();
    expect(foldReportedModel({}, { type: 'text', model: 'x' })).toBeUndefined();
    expect(sameModel('claude-opus-5-5[1m]', 'Claude-Opus-5-5')).toBe(true);
  });
});

describe('RunStore records the model the agent reported', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-reported-model-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('saves it on each step and as the run summary, and survives a reload', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 'auto',
      workflow: 'two-step',
      task: 'auto',
      steps: [
        { id: 'plan', name: 'Plan', kind: 'agent' },
        { id: 'build', name: 'Build', kind: 'agent' },
      ],
    });
    store.appendEvent(run.id, { type: 'session.started', sessionId: 's1', backend: 'claude', model: 'claude-sonnet-5-5', stepId: 'plan' });
    store.appendEvent(run.id, {
      type: 'turn.completed',
      turnId: 't1',
      stopReason: 'end_turn',
      stepId: 'plan',
      models: [
        { model: 'claude-sonnet-5-5', inputTokens: 50, outputTokens: 5, costUsd: 0.1 },
        { model: 'claude-haiku-5-5', inputTokens: 5, outputTokens: 1, costUsd: 0.001 },
      ],
    });
    store.appendEvent(run.id, { type: 'session.started', sessionId: 's2', backend: 'claude', model: 'claude-opus-5-5', stepId: 'build' });

    const check = (record: ReturnType<RunStore['getRun']>) => {
      expect(record?.steps[0]).toMatchObject({
        actualModel: 'claude-sonnet-5-5',
        modelsUsed: [
          { model: 'claude-sonnet-5-5', inputTokens: 50, outputTokens: 5, costUsd: 0.1 },
          { model: 'claude-haiku-5-5', inputTokens: 5, outputTokens: 1, costUsd: 0.001 },
        ],
      });
      expect(record?.steps[1]).toMatchObject({ actualModel: 'claude-opus-5-5', modelsUsed: [{ model: 'claude-opus-5-5' }] });
      expect(record).toMatchObject({
        actualModel: 'claude-opus-5-5',
        modelsUsed: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
      });
    };
    check(store.getRun(run.id));
    store.flush();
    check(RunStore.open(dataDir).getRun(run.id));
  });

  it('loads a record written before the fields existed, and drops an unreadable value instead of the run', () => {
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([
        { id: 'old', title: 't', workflow: 'quick-task', task: 't', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] },
        {
          id: 'bad', title: 't', workflow: 'quick-task', task: 't', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false,
          actualModel: 42, modelsUsed: 'nope',
          steps: [{ id: 's', name: 's', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, actualModel: {}, modelsUsed: [{ nope: true }] }],
        },
      ]),
    );
    const store = RunStore.open(dataDir);
    expect(store.getRun('old')).toBeDefined();
    expect(store.getRun('old')?.actualModel).toBeUndefined();
    const bad = store.getRun('bad');
    expect(bad).toBeDefined();
    expect(bad?.actualModel).toBeUndefined();
    expect(bad?.steps[0]?.actualModel).toBeUndefined();
    expect(bad?.steps[0]?.modelsUsed).toBeUndefined();
  });
});
