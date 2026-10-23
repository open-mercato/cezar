import { describe, expect, it } from 'vitest';
import * as lifecycle from './lifecycle.ts';
import type { RunLifecycleSnapshot } from '../runs/lifecycle.ts';
const now = Date.parse('2026-10-13T12:00:00Z');
const run = (patch: Partial<RunLifecycleSnapshot> = {}): RunLifecycleSnapshot => ({
  id: 'task-1', status: 'running', archived: false, title: 'agent title', titleOrigin: 'marker',
  attentionRequest: undefined, completionReason: undefined, autoResumeAt: undefined, finishedAt: undefined,
  startedAt: undefined, parentTaskId: undefined, rootTaskId: undefined, continuation: 0, error: undefined,
  pullRequestUrl: undefined, referencedPullRequestUrl: undefined, referencedIssueUrl: undefined, ...patch,
});
const question = { requestId: 'q1', askedAt: new Date(now).toISOString(), questions: [{ question: 'Private business question' }] };
const candidate = (patch: Partial<lifecycle.LifecycleCandidate> = {}): lifecycle.LifecycleCandidate => ({ type: 'task.failed' as const, occurredAt: new Date(now - 30_000).toISOString(), episodeId: 'task-1-1', snapshot: run({ status: 'failed' }), ...patch });
describe('webhook lifecycle selection and freshness', () => {
  it('captures a changed question but not re-emission of the same request or a title change', () => {
    const a = run({ status: 'waiting', attentionRequest: question });
    expect(lifecycle.transitionType(a, { ...a, title: 'renamed' })).toBeUndefined();
    expect(lifecycle.transitionType(a, { ...a, attentionRequest: { ...question, requestId: 'q2' } })).toBe('task.attention_required');
    expect(lifecycle.transitionType(a, { ...a, attentionRequest: undefined })).toBe('task.attention_required');
    expect(lifecycle.transitionType(run(), a)).toBe('task.attention_required');
  });
  it('treats clearing a failure schedule as a candidate except during archival', () => {
    const a = run({ status: 'failed', autoResumeAt: new Date(now + 60_000).toISOString() });
    expect(lifecycle.transitionType(a, { ...a, autoResumeAt: undefined })).toBe('task.failed');
    expect(lifecycle.transitionType(a, { ...a, autoResumeAt: undefined, archived: true })).toBeUndefined();
    expect(lifecycle.transitionType(undefined, a)).toBeUndefined();
  });
  it('defers failure while active, supersedes newer continuations, and respects 30s grace', () => {
    const source = candidate(); const current = source.snapshot;
    expect(lifecycle.freshness(source, { current, now, active: true, context: 'ready' })).toEqual({ kind: 'defer' });
    expect(lifecycle.freshness(source, { current: { ...current, continuation: 1 }, now, active: true, context: 'ready' })).toEqual({ kind: 'superseded', reason: 'newer_continuation' });
    expect(lifecycle.freshness({ ...source, occurredAt: new Date(now - 29_999).toISOString() }, { current, now, active: false, context: 'ready' })).toEqual({ kind: 'defer' });
  });
  it('treats disk-only resume metadata as manual and supersedes a frozen scheduled body', () => {
    const source = candidate(); const current = { ...source.snapshot, autoResumeAt: new Date(now + 60_000).toISOString() };
    expect(lifecycle.freshness(source, { current, now, active: false, context: 'unopened' })).toEqual({ kind: 'ready', disposition: 'manual' });
    expect(lifecycle.freshness(source, { current, now, active: false, context: 'unopened', frozen: { disposition: 'scheduled', autoResumeAt: current.autoResumeAt } })).toEqual({ kind: 'superseded', reason: 'failure_schedule_changed' });
  });
  it('supersedes frozen scheduled payloads when a live deadline changes', () => {
    const source = candidate(); const current = { ...source.snapshot, autoResumeAt: new Date(now + 60_000).toISOString() };
    expect(lifecycle.freshness(source, { current, now, active: false, context: 'ready', frozen: { disposition: 'scheduled', autoResumeAt: new Date(now + 120_000).toISOString() } })).toEqual({ kind: 'superseded', reason: 'failure_schedule_changed' });
  });
  it('requires a live manager timer before promising a scheduled resume', () => {
    const source = candidate(); const current = { ...source.snapshot, autoResumeAt: new Date(now + 60000).toISOString() };
    expect(lifecycle.freshness(source, { current, now, active: false, context: 'ready', resumeScheduled: false })).toEqual({ kind: 'ready', disposition: 'manual' });
    expect(lifecycle.freshness(source, { current, now, active: false, context: 'ready', resumeScheduled: true })).toEqual({ kind: 'ready', disposition: 'scheduled', autoResumeAt: current.autoResumeAt });
  });
  it('allows terminal snapshots after deletion but never resurrects unopened questions', () => {
    const source = candidate({ type: 'task.finished', snapshot: run({ status: 'done' }) });
    expect(lifecycle.freshness(source, { current: undefined, now, active: false, context: 'unopened' })).toEqual({ kind: 'ready' });
    expect(lifecycle.freshness(candidate({ type: 'task.attention_required', snapshot: run({ status: 'waiting' }) }), { current: run({ status: 'waiting' }), now, active: false, context: 'unopened' })).toEqual({ kind: 'superseded', reason: 'owner_restarted' });
  });
  it('limits default child notifications to explicit questions', () => {
    const receiver = { preset: 'attention' as const, events: [], includeScheduledFailures: false, scope: 'main_and_questions' as const };
    expect(lifecycle.selected(receiver, 'task.finished', run({ parentTaskId: 'root' }))).toBe(false);
    expect(lifecycle.selected(receiver, 'task.attention_required', run({ parentTaskId: 'root' }))).toBe(false);
    expect(lifecycle.selected(receiver, 'task.attention_required', run({ parentTaskId: 'root', attentionRequest: question }))).toBe(true);
    expect(lifecycle.selected(receiver, 'task.finished', run())).toBe(true);
    expect(lifecycle.selected(receiver, 'task.cancelled', run())).toBe(false);
  });
});
