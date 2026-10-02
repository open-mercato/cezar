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
});

describe('freshContinuationContext and the handoff journal', () => {
  const longConversation = (n: number): RunEvent[] =>
    Array.from({ length: n }, (_, i) =>
      event(i + 1, 'item.completed', { item: { id: `m${i}`, kind: 'message', role: 'assistant', text: `answer ${i} ${'x'.repeat(990)}` } }),
    );
  const handoff = [
    '# Handoff — Fix it',
    '',
    '## Goal',
    '',
    'Fix the checkout bug',
    '',
    '## Progress log',
    '',
    '- 2026-09-04T10:00:00.000Z — turn complete — status=waiting',
    '- 2026-09-04T09:50:00.000Z — fixed the API handler, tests green',
    '- 2026-09-04T09:40:00.000Z — step "task" complete — status=done',
    '',
    '## Resume notes',
    'Next: wire the UI to the new endpoint.',
    '',
  ].join('\n');

  it('carries what the previous session wrote and drops cezar heartbeats', () => {
    const context = freshContinuationContext(run(), [], handoff);
    expect(context).toContain('## Handoff journal (kept by the previous session)');
    expect(context).toContain('Next: wire the UI to the new endpoint.');
    expect(context).toContain('fixed the API handler, tests green');
    expect(context).not.toContain('status=waiting');
    expect(context).not.toContain('step "task" complete');
  });

  it('leans on the journal and sends a shorter slice of the raw transcript', () => {
    const withJournal = freshContinuationContext(run(), longConversation(100), handoff);
    const without = freshContinuationContext(run(), longConversation(100));
    const history = (context: string): string => context.slice(context.indexOf('## Conversation history'));
    expect(history(withJournal).length).toBeLessThanOrEqual(12_100);
    // Nothing else says where the task stands, so the journal-less hand-off keeps the full slice.
    expect(history(without).length).toBeGreaterThan(59_000);
    expect(history(without).length).toBeLessThanOrEqual(60_100);
    expect(withJournal).toContain('answer 99');
    expect(withJournal).toContain('(oldest messages truncated)');
  });

  it('adds no journal section for a handoff holding only heartbeats', () => {
    const heartbeatsOnly = '## Progress log\n\n- 2026-09-04T10:00:00.000Z — turn complete — status=waiting\n\n## Resume notes\n';
    expect(freshContinuationContext(run(), [], heartbeatsOnly)).not.toContain('Handoff journal');
  });

  it('keeps the full transcript when the journal carries no state', () => {
    // One stray progress line is not "where the task stands": the old gate shortened the
    // transcript on any non-empty journal, giving a provider hand-off a fifth of the conversation
    // in exchange for nothing.
    const thin = '## Progress log\n\n- 2026-09-04T09:50:00.000Z — started the refactor\n';
    const context = freshContinuationContext(run(), longConversation(100), thin);
    const history = context.slice(context.indexOf('## Conversation history'));
    expect(context).toContain('## Handoff journal (kept by the previous session)');
    expect(history.length).toBeGreaterThan(59_000);
    expect(history.length).toBeLessThanOrEqual(60_100);
  });

  it('marks a journal that was cut at the cap', () => {
    const oversized = `## Resume notes\n${'y'.repeat(9_000)}\n`;
    expect(freshContinuationContext(run(), [], oversized)).toContain('_(journal truncated)_');
  });

  it('never cuts a surrogate pair in half when one message overflows the cap', () => {
    // An odd tail after the pairs puts the cut on the low half of a pair.
    const emoji = '🙂'.repeat(40_000);
    const context = freshContinuationContext(run(), [
      event(1, 'item.completed', { item: { id: 'm1', kind: 'message', role: 'assistant', text: `${emoji}y` } }),
    ]);
    expect(context).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
