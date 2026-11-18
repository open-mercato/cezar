import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQuestionInbox } from './inbox.ts';
import { fakeProvider, taskItem } from './fake-provider.testkit.ts';
import { openRevision, questionsTopic } from './topic.ts';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('questions topic', () => {
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const task = fakeProvider('r', [taskItem('p1', 'run1', 'q1'), taskItem('p1', 'run2', 'q2')]);
    const inbox = createQuestionInbox({ task, olderAfterDays: async () => undefined });
    return { task, inbox, topic: questionsTopic(inbox, 50) };
  };

  const counts = (frames: unknown[]) => frames.map((frame) => { const { revision: _, ...rest } = frame as { revision?: string }; return rest; });

  it('snapshots the counts with the open list’s revision', async () => {
    const { inbox, topic } = setup();
    expect(await topic.snapshot()).toEqual({ live: 2, older: 0, revision: openRevision((await inbox.list()).open) });
  });

  // A re-ask closes one card and opens another: the counts hold, the list does not.
  it('publishes a new revision when the open list changed at equal counts', async () => {
    const { task, inbox, topic } = setup();
    const first = (await topic.snapshot()) as { revision?: string };
    const published: Array<{ live: number; older: number; revision?: string }> = [];
    const stop = topic.start((data) => published.push(data as never));
    task.items.set('r:p1:run3:q3', taskItem('p1', 'run3', 'q3'));
    task.closeFromSource('r:p1:run1:q1', { reason: 'replaced' });
    await inbox.idle();
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({ live: 2, older: 0 });
    expect(published[0]!.revision).not.toBe(first.revision);
    stop();
  });

  it('the revision follows keys, Older and flags, not their order', () => {
    const a = taskItem('p1', 'run1', 'q1');
    const b = taskItem('p1', 'run2', 'q2');
    expect(openRevision([a, b])).toBe(openRevision([b, a]));
    expect(openRevision([a, b])).not.toBe(openRevision([a]));
    expect(openRevision([a])).not.toBe(openRevision([{ ...a, older: true }]));
    expect(openRevision([a])).not.toBe(openRevision([{ ...a, stale: { why: 'replied-in-chat', detail: 'x', since: a.askedAt } }]));
  });

  it('publishes only when the counts changed', async () => {
    const { task, inbox, topic } = setup();
    await topic.snapshot();
    const published: unknown[] = [];
    const stop = topic.start((data) => published.push(data));
    inbox.refresh(); // nothing changed
    await flush();
    expect(published).toEqual([]);
    task.closeFromSource('r:p1:run1:q1', { reason: 'ended' });
    await inbox.idle();
    await flush();
    expect(counts(published)).toEqual([{ live: 1, older: 0 }]);
    inbox.refresh();
    await flush();
    expect(published).toHaveLength(1);
    stop();
  });

  it('listens only while subscribed', async () => {
    const { task, inbox, topic } = setup();
    const published: unknown[] = [];
    const stop = topic.start((data) => published.push(data));
    stop();
    task.closeFromSource('r:p1:run1:q1', { reason: 'ended' });
    await inbox.idle();
    await flush();
    expect(published).toEqual([]);
  });

  it('re-counts on a timer while subscribed, so a question crossing Older is pushed', async () => {
    let days: number | undefined;
    const task = fakeProvider('r', [taskItem('p1', 'run1', 'q1', { askedMsAgo: 2 * 86_400_000 })]);
    const inbox = createQuestionInbox({ task, olderAfterDays: async () => days });
    const topic = questionsTopic(inbox, 20);
    await topic.snapshot();
    const published: unknown[] = [];
    const stop = topic.start((data) => published.push(data));
    days = 1;
    await vi.waitFor(() => expect(counts(published)).toEqual([{ live: 0, older: 1 }]));
    stop();
  });
});
