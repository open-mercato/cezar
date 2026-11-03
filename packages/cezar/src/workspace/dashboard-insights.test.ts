import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { buildDashboardInsights, classifyFailure, projectInsightRow } from './dashboard-insights.ts';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const coverage = { projects: [{ projectId: 'p', state: 'complete' as const, omittedRuns: 0 }] };
const visible = { cost: true, tokens: true };
let seq = 0;
function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `r${++seq}`,
    title: 'task',
    workflow: 'quick-task',
    task: 'do it',
    status: 'done',
    createdAt: '2026-09-29T10:00:00.000Z',
    startedAt: '2026-09-29T10:00:00.000Z',
    finishedAt: '2026-09-29T11:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  } as RunRecord;
}
const build = (runs: RunRecord[], vis = visible, period: '7d' | '30d' = '7d') =>
  buildDashboardInsights(
    runs.map((r) => projectInsightRow('p', r)),
    coverage,
    { period, tzOffsetMinutes: 0 },
    vis,
    NOW,
  );

describe('dashboard insights', () => {
  it('counts delivered work from completed tasks only, separating opened from touched PRs', () => {
    const result = build([
      run({
        diffStat: { adds: 10, dels: 2, files: 3 },
        prRefs: [{ number: 5, origin: 'created', at: '2026-09-29T11:00:00.000Z' }],
        issueNumber: 9,
      }),
      run({ prRefs: [{ number: 7, origin: 'derived', at: '2026-09-29T11:00:00.000Z' }] }),
      // Legacy record: a bare URL is the PR cezar opened.
      run({ prNumber: 8, pullRequestUrl: 'https://github.com/o/r/pull/8' }),
      run({ status: 'failed', diffStat: { adds: 99, dels: 99, files: 99 }, error: 'boom' }),
    ]);
    expect(result.delivered).toEqual({
      completedTasks: 3,
      prsOpened: 2,
      prsTouched: 3,
      issues: 1,
      additions: 10,
      deletions: 2,
      files: 3,
      measuredTasks: 1,
    });
  });

  it('leaves a usage-limit park and work outside the window out of every outcome', () => {
    const result = build([
      run({ status: 'failed', error: 'usage limit', autoResumeAt: '2026-09-30T13:00:00.000Z' }),
      run({ finishedAt: '2026-09-20T11:00:00.000Z' }),
    ]);
    expect(result.failures.total).toBe(0);
    expect(result.delivered.completedTasks).toBe(0);
    expect(result.backends).toEqual([]);
  });

  it('leaves a run awaiting an answer out of every outcome — it is still a question', () => {
    const result = build([
      run({
        status: 'failed',
        error: 'the session closed before the question was answered',
        awaitingAnswerSince: '2026-09-30T11:00:00.000Z',
      }),
    ]);
    expect(result.failures.total).toBe(0);
    expect(result.delivered.completedTasks).toBe(0);
    expect(result.backends).toEqual([]);
  });

  it('groups failures by classified reason and keeps the most recent example', () => {
    const result = build([
      run({ status: 'failed', error: 'HTTP 429: rate limit', finishedAt: '2026-09-29T09:00:00.000Z' }),
      run({ status: 'failed', error: 'Rate limit exceeded', title: 'newest', finishedAt: '2026-09-29T12:00:00.000Z' }),
      run({
        status: 'failed',
        steps: [
          { id: 'verify', name: 'verify', kind: 'check', status: 'failed', iterations: 1, tokensUsed: 0, error: '3 tests failed' },
        ],
      } as Partial<RunRecord>),
    ]);
    expect(result.failures.total).toBe(3);
    expect(result.failures.reasons.map((r) => [r.label, r.count])).toEqual([
      ['Usage or rate limit', 2],
      ['Check failed: verify', 1],
    ]);
    expect(result.failures.reasons[0]!.latest.title).toBe('newest');
    expect(result.failures.reasons[1]!.latest.step).toBe('verify');
  });

  it('bounds an unclassified error to its first line', () => {
    const row = projectInsightRow('p', run({ status: 'failed', error: `\n${'x'.repeat(400)}\nstack` }));
    const { category, message } = classifyFailure(row);
    expect(category).toBe('other');
    expect(message.length).toBeLessThanOrEqual(240);
    expect(message).not.toContain('stack');
  });

  it('compares backends and models, and drops cost when settings hide it', () => {
    const runs = [
      run({ runner: 'claude', model: 'opus', costUsd: 2 }),
      run({ runner: 'claude', model: 'opus', status: 'failed', costUsd: 1 }),
      run({ runner: 'codex', costUsd: 0.5 }),
    ];
    const shown = build(runs);
    expect(shown.backends.map((b) => [b.backend, b.model, b.finished, b.done, b.failed])).toEqual([
      ['claude', 'opus', 2, 1, 1],
      ['codex', undefined, 1, 1, 0],
    ]);
    expect(shown.backends[0]!.costUsd).toEqual({ value: 3, reportedTasks: 2 });
    expect(shown.backends[0]!.medianCycleHours).toBe(1);
    const hidden = build(runs, { cost: false, tokens: true });
    expect(hidden.backends.every((b) => !('costUsd' in b))).toBe(true);
    expect(hidden.automations.every((a) => !('costUsd' in a))).toBe(true);
  });

  it('attributes tasks to the automation that launched them, scheduled or event-driven', () => {
    const trigger = {
      automationId: 'nightly',
      automationRevision: 1,
      receiptId: 'x',
      trigger: 'schedule' as const,
      occurrenceAt: '2026-09-29T02:00:00.000Z',
    };
    const result = build([
      run({ automationTrigger: trigger, costUsd: 1 }),
      run({ automationTrigger: trigger, status: 'running', finishedAt: undefined, createdAt: '2026-09-30T02:00:00.000Z' }),
      run({
        automation: { automationId: 'on-issue', automationRevision: 1, receiptId: 'y', event: 'issue', githubUrl: 'u' },
        status: 'failed',
      }),
      run({ automationTrigger: trigger, createdAt: '2026-09-01T02:00:00.000Z' }),
    ]);
    expect(result.automations).toEqual([
      {
        projectId: 'p',
        automationId: 'nightly',
        tasks: 2,
        done: 1,
        failed: 0,
        active: 1,
        lastRunAt: '2026-09-30T02:00:00.000Z',
        lastStatus: 'running',
        costUsd: { value: 1, reportedTasks: 1 },
      },
      {
        projectId: 'p',
        automationId: 'on-issue',
        tasks: 1,
        done: 0,
        failed: 1,
        active: 0,
        lastRunAt: '2026-09-29T10:00:00.000Z',
        lastStatus: 'failed',
        costUsd: { value: null, reportedTasks: 0 },
      },
    ]);
  });

  it('credits the backend that ran, and never pairs a model with a backend that did not run it', () => {
    const step = (backend: 'claude' | 'codex') => ({
      id: backend,
      name: backend,
      kind: 'agent' as const,
      status: 'done' as const,
      iterations: 1,
      tokensUsed: 0,
      backend,
    });
    const result = build([
      // Created on claude, the only step overridden onto codex: the identity is codex's.
      run({ runner: 'claude', model: 'opus', modelIdentity: 'openai/gpt-5', steps: [step('codex')] }),
      run({ runner: 'claude', modelIdentity: 'openai/gpt-5', steps: [step('claude'), step('codex')] }),
      // No step recorded a backend (older record): fall back to the task's own pair.
      run({ runner: 'claude', model: 'opus' }),
    ]);
    expect(result.backends.map((b) => [b.backend, b.model])).toEqual([
      ['claude', 'opus'],
      ['codex', 'openai/gpt-5'],
      ['mixed', undefined],
    ]);
  });

  it('keeps a task parked on a usage limit active, not vanished', () => {
    const result = build([
      run({
        automationTrigger: {
          automationId: 'nightly',
          automationRevision: 1,
          receiptId: 'x',
          trigger: 'schedule',
          occurrenceAt: '2026-09-29T02:00:00.000Z',
        },
        status: 'failed',
        autoResumeAt: '2026-09-30T13:00:00.000Z',
      }),
    ]);
    expect(result.automations[0]).toMatchObject({ tasks: 1, done: 0, failed: 0, active: 1 });
  });

  it('counts an automation task awaiting an answer as active, not failed', () => {
    const result = build([
      run({
        automationTrigger: {
          automationId: 'nightly',
          automationRevision: 1,
          receiptId: 'y',
          trigger: 'schedule',
          occurrenceAt: '2026-09-29T02:00:00.000Z',
        },
        status: 'failed',
        awaitingAnswerSince: '2026-09-30T11:00:00.000Z',
      }),
    ]);
    expect(result.automations[0]).toMatchObject({ tasks: 1, done: 0, failed: 0, active: 1 });
  });
});
