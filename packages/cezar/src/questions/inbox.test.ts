import { describe, expect, it } from 'vitest';
import { QUESTIONS_CLOSED_MAX } from '@open-mercato/cezar-contract';
import { createQuestionInbox, resolveOlderAfterDays, type QuestionInboxDeps } from './inbox.ts';
import { fakeProvider, managerItem, taskItem } from './fake-provider.testkit.ts';

const DAY = 86_400_000;
const relayOf = (ask: string) => ({ about: [{ task: 'p1/run1', ask }] });

function setup(opts: { tasks?: Parameters<typeof fakeProvider>[1]; managers?: Parameters<typeof fakeProvider>[1] } & Partial<QuestionInboxDeps> = {}) {
  const task = fakeProvider('r', opts.tasks ?? []);
  const manager = fakeProvider('m', opts.managers ?? []);
  const inbox = createQuestionInbox({ task, manager, ...opts, ...(opts.olderAfterDays ? {} : { olderAfterDays: async () => undefined }) });
  return { task, manager, inbox };
}

describe('Questions inbox: merge, Older and counts', () => {
  it('merges both providers, newest first, and counts every open question', async () => {
    const { inbox } = setup({ tasks: [taskItem('p1', 'run1', 'q1', { askedMsAgo: 10_000 })], managers: [managerItem('a', 'm1', { askedMsAgo: 5_000 })] });
    const list = await inbox.list();
    expect(list.open.map((item) => item.key)).toEqual(['m:a:m1', 'r:p1:run1:q1']);
    expect(list.counts).toEqual({ live: 2, older: 0 });
    expect(list.olderAfterDays).toBe(7);
  });

  it('moves a question open longer than the default 7 days to Older, out of the live count', async () => {
    const { inbox } = setup({ tasks: [taskItem('p1', 'run1', 'q1', { askedMsAgo: 8 * DAY }), taskItem('p1', 'run2', 'q2', { askedMsAgo: 6 * DAY })] });
    const list = await inbox.list();
    expect(list.open.find((item) => item.key === 'r:p1:run1:q1')!.older).toBe(true);
    expect(list.open.find((item) => item.key === 'r:p1:run2:q2')!.older).toBe(false);
    expect(list.counts).toEqual({ live: 1, older: 1 });
  });

  it('honours a custom threshold and 0 = off', async () => {
    const tasks = [taskItem('p1', 'run1', 'q1', { askedMsAgo: 2 * DAY })];
    expect((await setup({ tasks, olderAfterDays: async () => 1 }).inbox.counts())).toEqual({ live: 0, older: 1 });
    expect((await setup({ tasks: [taskItem('p1', 'run1', 'q1', { askedMsAgo: 400 * DAY })], olderAfterDays: async () => 0 }).inbox.counts())).toEqual({ live: 1, older: 0 });
  });

  it('treats a missing or malformed setting as the default', () => {
    expect([undefined, -1, 1.5, '3', null].map(resolveOlderAfterDays)).toEqual([7, 7, 7, 7, 7]);
    expect(resolveOlderAfterDays(0)).toBe(0);
    expect(resolveOlderAfterDays(30)).toBe(30);
  });

  it('keeps closed questions of the last 7 days only, newest first, at most 50', async () => {
    const closedAt = (msAgo: number) => ({ reason: 'ended' as const, at: new Date(Date.now() - msAgo).toISOString() });
    const tasks = [
      taskItem('p1', 'old', 'q', { closed: closedAt(8 * DAY) }),
      taskItem('p1', 'recent', 'q', { closed: closedAt(DAY) }),
      taskItem('p1', 'newest', 'q', { closed: closedAt(1_000) }),
      ...Array.from({ length: 60 }, (_, i) => taskItem('p2', `bulk${i}`, 'q', { closed: closedAt(2 * DAY + i) })),
    ];
    const list = await setup({ tasks }).inbox.list();
    expect(list.closed).toHaveLength(QUESTIONS_CLOSED_MAX);
    expect(list.closed[0]!.key).toBe('r:p1:newest:q');
    expect(list.closed[1]!.key).toBe('r:p1:recent:q');
    expect(list.closed.some((item) => item.key === 'r:p1:old:q')).toBe(false);
    expect(list.counts).toEqual({ live: 0, older: 0 });
  });

  it('lists an inactive manager\'s questions but leaves them out of both counts (spec 2026-11-19-manager-deactivate)', async () => {
    const { inbox } = setup({
      tasks: [taskItem('p1', 'run1', 'q1', { askedMsAgo: 10_000 })],
      managers: [managerItem('a', 'm1', { askedMsAgo: 5_000 }), managerItem('b', 'm2', { askedMsAgo: 9 * DAY })],
      managerInactive: (managerId) => managerId === 'a' || managerId === 'b',
    });
    const list = await inbox.list();
    expect(list.open.map((item) => item.key)).toEqual(['m:a:m1', 'r:p1:run1:q1', 'm:b:m2']);
    expect(list.counts).toEqual({ live: 1, older: 0 });
  });

  it('serves task questions alone when managers are off', async () => {
    const { inbox } = setup({ tasks: [taskItem('p1', 'run1', 'q1')], managers: [managerItem('a', 'm1')], managersEnabled: () => false });
    expect((await inbox.list()).open.map((item) => item.key)).toEqual(['r:p1:run1:q1']);
    expect(await inbox.answer('m:a:m1', 'x')).toMatchObject({ ok: false, status: 404 });
  });

  it('degrades a failing provider to an empty list', async () => {
    const { inbox, manager } = setup({ tasks: [taskItem('p1', 'run1', 'q1')], managers: [managerItem('a', 'm1')] });
    manager.failList = true;
    expect((await inbox.counts()).live).toBe(1);
  });
});

describe('Questions inbox: relayed pairs', () => {
  it('folds a manager copy into the task item by card id, counted once', async () => {
    const { inbox } = setup({ tasks: [taskItem('p1', 'run1', 'req1', { cardId: 'scope' })], managers: [managerItem('a', 'm1', relayOf('scope'))] });
    const list = await inbox.list();
    expect(list.open).toHaveLength(1);
    expect(list.open[0]).toMatchObject({ key: 'r:p1:run1:req1', linked: { key: 'm:a:m1', source: { kind: 'manager', managerId: 'a' } } });
    expect(list.counts.live).toBe(1);
  });

  it('folds by request id too', async () => {
    const { inbox } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', relayOf('req1'))] });
    expect((await inbox.list()).open.map((item) => item.key)).toEqual(['r:p1:run1:req1']);
  });

  it('keeps a manager card naming another question, or only the task, separate', async () => {
    const { inbox } = setup({
      tasks: [taskItem('p1', 'run1', 'req1', { cardId: 'scope' })],
      managers: [managerItem('a', 'm1', relayOf('other')), managerItem('a', 'm2', { about: [{ task: 'p1/run1' }] })],
    });
    expect((await inbox.list()).counts.live).toBe(3);
  });

  it('shows nothing extra when the manager copy is already closed', async () => {
    const dismissed = { reason: 'dismissed' as const, at: new Date().toISOString() };
    const { inbox } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', { ...relayOf('req1'), closed: dismissed })] });
    const list = await inbox.list();
    expect(list.open).toHaveLength(1);
    expect(list.open[0]!.linked).toBeUndefined();
    expect(list.closed).toEqual([]);
  });

  it('answered in the task closes the manager copy with the answer', async () => {
    const { inbox, task, manager } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', relayOf('req1'))] });
    await task.answer('r:p1:run1:req1', 'Ship it');
    await inbox.idle();
    expect(manager.items.get('m:a:m1')!.closed).toMatchObject({ reason: 'answered', answeredIn: 'task:p1/run1', answer: 'Ship it' });
    const list = await inbox.list();
    expect(list.counts.live).toBe(0);
    expect(list.closed.map((item) => item.key)).toEqual(['r:p1:run1:req1']);
    expect(list.closed[0]!.linked?.key).toBe('m:a:m1');
  });

  it('answered on the manager card delivers to the task once and marks where', async () => {
    const { inbox, task, manager } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', relayOf('req1'))] });
    await manager.answer('m:a:m1', 'Option B');
    await inbox.idle();
    expect(task.calls.filter((call) => call.op === 'answer')).toEqual([{ op: 'answer', key: 'r:p1:run1:req1', text: 'Option B' }]);
    const closed = (await inbox.list()).closed;
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closed).toMatchObject({ reason: 'answered', answer: 'Option B', answeredIn: 'manager:a' });
    // The task's own close did not bounce back onto the manager copy.
    expect(manager.calls.filter((call) => call.op === 'close')).toEqual([]);
  });

  it.each(['replaced', 'retracted', 'ended', 'expired', 'dismissed'] as const)('a task question closed as %s closes the manager copy the same way', async (reason) => {
    const { inbox, task, manager } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', relayOf('req1'))] });
    task.closeFromSource('r:p1:run1:req1', { reason, detail: 'why' });
    await inbox.idle();
    expect(manager.items.get('m:a:m1')!.closed).toMatchObject({ reason, detail: 'why' });
    expect(manager.items.get('m:a:m1')!.closed!.answeredIn).toBeUndefined();
  });

  it('a manager copy closed for any other reason leaves the task asking', async () => {
    const { inbox, task, manager } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', relayOf('req1'))] });
    manager.closeFromSource('m:a:m1', { reason: 'replaced' });
    await inbox.idle();
    expect(task.calls).toEqual([]);
    expect((await inbox.counts()).live).toBe(1);
  });

  it('answering the linked manager key from the inbox answers the task copy, once', async () => {
    const { inbox, task, manager } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', relayOf('req1'))] });
    const result = await inbox.answer('m:a:m1', 'Go');
    await inbox.idle();
    expect(result).toMatchObject({ ok: true, item: { key: 'r:p1:run1:req1', closed: { reason: 'answered', answer: 'Go' } } });
    expect(task.calls.filter((call) => call.op === 'answer')).toHaveLength(1);
    expect(manager.calls.filter((call) => call.op === 'answer')).toEqual([]);
    expect(manager.items.get('m:a:m1')!.closed).toMatchObject({ reason: 'answered', answeredIn: 'task:p1/run1' });
  });

  it('dismissing the pair from the inbox closes both copies', async () => {
    const { inbox, manager } = setup({ tasks: [taskItem('p1', 'run1', 'req1')], managers: [managerItem('a', 'm1', relayOf('req1'))] });
    expect(await inbox.dismiss('r:p1:run1:req1')).toMatchObject({ ok: true, item: { closed: { reason: 'dismissed' } } });
    await inbox.idle();
    expect(manager.items.get('m:a:m1')!.closed?.reason).toBe('dismissed');
    expect((await inbox.counts()).live).toBe(0);
  });
});

describe('Questions inbox: mutations', () => {
  it('404s an unknown key and passes a provider 409 through', async () => {
    const answered = { reason: 'answered' as const, at: new Date().toISOString(), answer: 'x' };
    const { inbox } = setup({ tasks: [taskItem('p1', 'run1', 'req1', { closed: answered })] });
    expect(await inbox.answer('x:nope', 'a')).toMatchObject({ ok: false, status: 404 });
    expect(await inbox.answer('r:p1:run9:req', 'a')).toMatchObject({ ok: false, status: 404 });
    expect(await inbox.dismiss('r:p1:run1:req1')).toMatchObject({ ok: false, status: 409 });
  });

  it('tells listeners when a provider changes', async () => {
    const { inbox, task } = setup({ tasks: [taskItem('p1', 'run1', 'req1')] });
    let calls = 0;
    const off = inbox.onChange(() => { calls += 1; });
    task.closeFromSource('r:p1:run1:req1', { reason: 'ended' });
    await inbox.idle();
    expect(calls).toBeGreaterThan(0);
    off();
    const before = calls;
    inbox.refresh();
    expect(calls).toBe(before);
  });
});
