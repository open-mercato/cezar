import { describe, expect, it } from 'vitest';

import type { RunEvent, RunRecord } from '../runs/store.ts';
import { freshContinuationContext } from './continuation-context.ts';

const run = (extra: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1', title: 'Fix it', workflow: 'quick-task', task: 'Fix the checkout bug',
  status: 'failed', error: 'Claude AI usage limit reached', createdAt: '2026-09-04T09:00:00Z',
  tokensUsed: 12, archived: false, branch: 'cez/r1', worktreePath: '/repo/.ai/cezar/worktrees/r1',
  steps: [{ id: 'task', name: 'Work', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 12 }],
  ...extra,
});

const event = (seq: number, type: string, extra: Record<string, unknown>): RunEvent => ({
  seq, type, ts: '2026-09-04T09:00:00Z', ...extra,
});

describe('freshContinuationContext', () => {
  it('carries task state and the persisted conversation without a handoff file', () => {
    const context = freshContinuationContext(run(), [
      event(1, 'user-message', { text: 'Please start with the API.' }),
      event(2, 'item.completed', { item: { id: 'm1', kind: 'message', role: 'assistant', text: 'API is fixed.' } }),
    ]);
    expect(context).toContain('Fix the checkout bug');
    expect(context).toContain('Status: failed');
    expect(context).toContain('Claude AI usage limit reached');
    expect(context).toContain('Worktree: /repo/.ai/cezar/worktrees/r1');
    expect(context).toContain('User:\nPlease start with the API.');
    expect(context).toContain('Assistant:\nAPI is fixed.');
  });

  it('prefers normalized v2 messages over their duplicate legacy text events', () => {
    const context = freshContinuationContext(run(), [
      event(1, 'text', { text: 'same answer' }),
      event(2, 'item.completed', { item: { id: 'm1', kind: 'message', role: 'assistant', text: 'same answer' } }),
    ]);
    expect(context.match(/same answer/g)).toHaveLength(1);
  });

  it('falls back to legacy assistant text for old task histories', () => {
    const context = freshContinuationContext(run(), [event(1, 'text', { text: 'legacy answer' })]);
    expect(context).toContain('Assistant:\nlegacy answer');
  });

  /**
   * The shape a crash BEFORE the first spawn leaves behind (spec
   * 2026-09-11-continue-without-a-session): a task and an error and nothing else. This builder was
   * written for the runner-switch case, where a conversation always exists; it now also has to
   * brief a session that is replacing one which never said anything, so "no messages" must read
   * as an honest empty rather than a truncated or malformed hand-off.
   */
  it('still briefs a session whose predecessor never produced a message', () => {
    const context = freshContinuationContext(run(), [event(1, 'lifecycle', { message: 'run started' })]);
    expect(context).toContain('Fix the checkout bug');
    expect(context).toContain('Status: failed');
    expect(context).toContain('(No persisted conversation messages.)');
  });

  /** A replay is text the next agent reads as its own opening context. `CEZ:DONE` in it would be
   *  read as a marker — the session would close the turn it was just handed. */
  it('strips the CEZ markers out of replayed messages', () => {
    const context = freshContinuationContext(run(), [
      event(1, 'text', { text: 'All set.\n\nCEZ:DONE' }),
      event(2, 'text', { text: 'CEZ:PR=974\nOpened the PR.' }),
    ]);
    expect(context).toContain('All set.');
    expect(context).toContain('Opened the PR.');
    expect(context).not.toContain('CEZ:DONE');
    expect(context).not.toContain('CEZ:PR=974');
  });

  it('replays conversation only — not lifecycle lines, notes or tool traffic', () => {
    const context = freshContinuationContext(run(), [
      event(1, 'lifecycle', { message: 'waiting for exclusive access to the repository working tree' }),
      event(2, 'note', { message: 'a note nobody said out loud' }),
      event(3, 'item.completed', { item: { id: 't1', kind: 'tool', toolKind: 'bash', title: 'git status' } }),
      event(4, 'user-message', { text: 'carry on' }),
    ]);
    expect(context).toContain('User:\ncarry on');
    expect(context).not.toContain('exclusive access');
    expect(context).not.toContain('nobody said out loud');
    expect(context).not.toContain('git status');
  });

  it('says so when the oldest messages had to go, rather than truncating silently', () => {
    const events = Array.from({ length: 400 }, (_, i) =>
      event(i + 1, 'text', { text: `answer ${i} ${'x'.repeat(400)}` }),
    );
    const context = freshContinuationContext(run(), events);
    expect(context).toContain('## Conversation history (oldest messages truncated)');
    expect(context).toContain('answer 399');
    expect(context).not.toContain('answer 0 ');
  });
});
