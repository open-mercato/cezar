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

const DIR = '/repo/.ai/cezar/runs/r1-images';

describe('freshContinuationContext', () => {
  it('hands the new provider the paths of screenshots pasted into the old session', () => {
    const context = freshContinuationContext(run({ taskImages: ['/api/v1/runs/r1/images/pasted-1.png'] }), [
      event(1, 'user-message', { text: 'is this true?', images: ['/api/v1/runs/r1/images/pasted-2.png'] }),
      event(2, 'user-message', { text: '', images: ['/api/v1/runs/r1/images/pasted-3.png'] }),
    ], DIR);
    expect(context).toContain('Fix the checkout bug\nAttached files:\n- /repo/.ai/cezar/runs/r1-images/pasted-1.png');
    expect(context).toContain('User:\nis this true?\nAttached files:\n- /repo/.ai/cezar/runs/r1-images/pasted-2.png');
    expect(context).toContain('User:\nAttached files:\n- /repo/.ai/cezar/runs/r1-images/pasted-3.png');
  });

  it('lists the files of a task given as attachments only', () => {
    const context = freshContinuationContext(run({ task: '  ', taskImages: ['/api/v1/runs/r1/images/spec.pdf'] }), [], DIR);
    expect(context).toContain('## Original task\n(given as attachments only)\nAttached files:\n- /repo/.ai/cezar/runs/r1-images/spec.pdf');
  });

  it('carries task state and the persisted conversation without a handoff file', () => {
    const context = freshContinuationContext(run(), [
      event(1, 'user-message', { text: 'Please start with the API.' }),
      event(2, 'item.completed', { item: { id: 'm1', kind: 'message', role: 'assistant', text: 'API is fixed.' } }),
    ], DIR);
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
    ], DIR);
    expect(context.match(/same answer/g)).toHaveLength(1);
  });

  it('omits the status a queued continuation stamped on the run, keeping the step history', () => {
    const context = freshContinuationContext(run({ status: 'queued', error: undefined }), [], DIR);
    expect(context).not.toContain('Status: queued');
    expect(context).toContain('- task (agent): failed');
  });

  it('falls back to legacy assistant text for old task histories', () => {
    const context = freshContinuationContext(run(), [event(1, 'text', { text: 'legacy answer' })], DIR);
    expect(context).toContain('Assistant:\nlegacy answer');
  });
});
