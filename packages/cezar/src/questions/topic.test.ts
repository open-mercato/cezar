import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQuestionInbox } from './inbox.ts';
import { fakeProvider, taskItem } from './fake-provider.testkit.ts';
import { questionsTopic } from './topic.ts';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('questions topic', () => {
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const task = fakeProvider('r', [taskItem('p1', 'run1', 'q1'), taskItem('p1', 'run2', 'q2')]);
    const inbox = createQuestionInbox({ task, olderAfterDays: async () => undefined });
    return { task, inbox, topic: questionsTopic(inbox, 50) };
  };

  it('snapshots the counts', async () => {
    expect(await setup().topic.snapshot()).toEqual({ live: 2, older: 0 });
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
    expect(published).toEqual([{ live: 1, older: 0 }]);
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
    await vi.waitFor(() => expect(published).toEqual([{ live: 0, older: 1 }]));
    stop();
  });
});
