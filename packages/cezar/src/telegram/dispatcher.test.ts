import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandLimiter, renderTelegramSourceOutcome, renderTelegramTaskReply, TelegramReplies } from './dispatcher.ts';
import { TelegramApiError } from './client.ts';
afterEach(() => vi.useRealTimers());
describe('Telegram bounded replies and command limits', () => {
  it('rechecks grant before send and drops revoked queued replies', async () => {
    vi.useFakeTimers(); const call = vi.fn().mockResolvedValue({}); let valid = true;
    const replies = new TelegramReplies(call);
    replies.enqueue('123', 'secret data', () => valid); valid = false;
    await vi.runAllTimersAsync(); expect(call).not.toHaveBeenCalled(); await replies.stop();
  });
  it('bounds the per-chat queue, expires a long 429, and never retries the task action', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(new TelegramApiError('http', 429, 3600));
    const replies = new TelegramReplies(call);
    for (let index = 0; index < 10; index++) expect(replies.enqueue('123', 'reply', () => true)).toBe(true);
    expect(replies.enqueue('123', 'overflow', () => true)).toBe(false);
    await vi.advanceTimersByTimeAsync(0); expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600_000); expect(call).toHaveBeenCalledTimes(1);
    await replies.stop();
  });
  it('does not retry a successful send because correlation storage failed', async () => {
    vi.useFakeTimers(); const call = vi.fn().mockResolvedValue({}); const replies = new TelegramReplies(call);
    replies.enqueue('123', 'reply', () => true, async () => { throw new Error('storage'); });
    await vi.runAllTimersAsync(); expect(call).toHaveBeenCalledTimes(1); await replies.stop();
  });
  it('keeps no more than three network attempts', async () => {
    vi.useFakeTimers(); const call = vi.fn().mockRejectedValue(new TelegramApiError('network')); const replies = new TelegramReplies(call);
    replies.enqueue('123', 'reply', () => true); await vi.runAllTimersAsync(); expect(call).toHaveBeenCalledTimes(3); await replies.stop();
  });
  it('bounds per-user and bot command rates independently', () => {
    let now = 0; const limiter = new CommandLimiter(() => now);
    for (let i = 0; i < 20; i++) expect(limiter.accept('user')).toBe(true);
    expect(limiter.accept('user')).toBe(false);
    for (let i = 0; i < 80; i++) expect(limiter.accept(`other-${i}`)).toBe(true);
    expect(limiter.accept('fresh')).toBe(false);
    now = 60_000; expect(limiter.accept('user')).toBe(true);
  });
});
it('sends confirmation markup only while valid and retains the successful message receipt', async () => {
  vi.useFakeTimers();
  const receipt = { message_id: 77, chat: { id: 123 } }, call = vi.fn().mockResolvedValue(receipt), sent = vi.fn(async () => {});
  const replies = new TelegramReplies(call);
  replies.enqueue('123', 'Preview', () => true, sent, { text: 'Confirm', callback_data: 'a'.repeat(32) });
  await vi.runAllTimersAsync();
  expect(call).toHaveBeenCalledWith('sendMessage', expect.objectContaining({ reply_markup: { inline_keyboard: [[{ text: 'Confirm', callback_data: 'a'.repeat(32) }]] } }), expect.any(AbortSignal), { valid: expect.any(Function) });
  expect(sent).toHaveBeenCalledWith(receipt); await replies.stop();
});
it('sends option rows as given and drops stale markup when a keyed reply is superseded without buttons', async () => {
  vi.useFakeTimers();
  const call = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: 123 } }), replies = new TelegramReplies(call);
  const rows = [[{ text: 'main', callback_data: 'a'.repeat(32) }], [{ text: 'release', callback_data: 'b'.repeat(32) }]];
  replies.deliver('123', 'Question', { key: 'notice', valid: () => true }, rows);
  replies.deliver('123', 'Done', { key: 'notice', valid: () => true });
  replies.deliver('123', 'Next question', { valid: () => true }, rows);
  await vi.runAllTimersAsync();
  expect(call.mock.calls.map(([, body]) => [body.text, body.reply_markup])).toEqual([['Done', undefined], ['Next question', { inline_keyboard: rows }]]);
  await replies.stop();
});
it('uses the controller budget shared with webhook deliveries', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget();
  budget.offer({ id: 'webhook', chat: '123', readyAt: 0, expiresAt: 10_000, valid: () => true });
  expect(budget.take('webhook')).toBe(true);
  const call = vi.fn().mockResolvedValue({}), replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'answer', () => true);
  await vi.advanceTimersByTimeAsync(999); expect(call).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(call).toHaveBeenCalledTimes(1);
  await replies.stop();
});
it('does not let a reply bypass an older ready webhook ticket', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget(), call = vi.fn().mockResolvedValue({});
  budget.offer({ id: 'webhook', chat: '456', readyAt: 0, expiresAt: 10_000, valid: () => true });
  const replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'answer', () => true);
  await vi.advanceTimersByTimeAsync(100); expect(call).not.toHaveBeenCalled();
  expect(budget.take('webhook')).toBe(true);
  await vi.advanceTimersByTimeAsync(99); expect(call).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(call).toHaveBeenCalledTimes(1);
  await replies.stop();
});
it('binds a recreated reply dispatcher to an existing credential cooldown', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget, clearSharedTelegramCooldowns } = await import('./send-budget.ts');
  clearSharedTelegramCooldowns();
  const previous = new TelegramSendBudget(); previous.share('bot'); previous.cooldown(60_000);
  const budget = new TelegramSendBudget(); budget.share('bot');
  const call = vi.fn().mockResolvedValue({}), replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'answer', () => true);
  await vi.advanceTimersByTimeAsync(1000); expect(call).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(59_000); expect(call).toHaveBeenCalledTimes(1);
  await replies.stop(); clearSharedTelegramCooldowns();
});
it('publishes a reply 429 into the shared budget even when the response expires', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget(), call = vi.fn().mockRejectedValue(new TelegramApiError('http', 429, 3600));
  const replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'answer', () => true); await vi.advanceTimersByTimeAsync(0);
  budget.offer({ id: 'webhook', chat: '456', readyAt: 0, expiresAt: 7200_000, valid: () => true });
  await vi.advanceTimersByTimeAsync(1000); expect(budget.take('webhook')).toBe(false);
  await replies.stop();
  vi.setSystemTime(3600_000); expect(budget.take('webhook')).toBe(true);
});
it('keeps a retry ahead of later messages in the same chat', async () => {
  vi.useFakeTimers();
  const call = vi.fn().mockRejectedValueOnce(new TelegramApiError('http', 500)).mockResolvedValue({});
  const replies = new TelegramReplies(call);
  replies.enqueue('123', 'first', () => true); replies.enqueue('123', 'second', () => true);
  await vi.runAllTimersAsync();
  expect(call.mock.calls.map(args => args[1].text)).toEqual(['first', 'first', 'second']); await replies.stop();
});
it('does not reserve another transport until an outstanding response has published its cooldown', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget(); let reject!: (error: Error) => void;
  const call = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
  const replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'first', () => true); await vi.advanceTimersByTimeAsync(0);
  budget.offer({ id: 'webhook', chat: '456', readyAt: 0, expiresAt: 120_000, valid: () => true });
  await vi.advanceTimersByTimeAsync(1000); expect(budget.reserve('webhook')).toBeUndefined();
  reject(new TelegramApiError('http', 429, 60)); await vi.advanceTimersByTimeAsync(0);
  expect(budget.reserve('webhook')).toBeUndefined(); await replies.stop();
});
it('coalesces unsent progress while retaining a separate final reply', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const call = vi.fn().mockResolvedValue({ message_id: 1 }), replies = new TelegramReplies(call);
  expect(replies.deliver('123', 'Running', { key: 'progress', valid: () => true })).toBe(true);
  expect(replies.deliver('123', 'Waiting for input', { key: 'progress', valid: () => true })).toBe(true);
  expect(replies.deliver('123', 'Completed', { key: 'final', valid: () => true })).toBe(true);
  await vi.runAllTimersAsync();
  expect(call.mock.calls.map(args => args[1].text)).toEqual(['Waiting for input', 'Completed']);
  await replies.stop();
});
it('drops queued progress when the terminal observation arrives before send', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget();
  budget.offer({ id: 'webhook', chat: '123', readyAt: 10_000, expiresAt: 20_000, valid: () => true });
  const call = vi.fn().mockResolvedValue({ message_id: 1 });
  const replies = new TelegramReplies(call, Date.now, budget);
  expect(replies.deliver('123', 'Running', { key: 'source-progress:run-1', valid: () => true })).toBe(true);
  expect(replies.cancel('source-progress:run-1')).toBe(true);
  expect(replies.deliver('123', 'Completed', { key: 'source-final:run-1', valid: () => true })).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(call.mock.calls.map(args => args[1].text)).toEqual(['Completed']);
  await replies.stop();
});
it('records terminal delivery failure only after transport retries are exhausted', async () => {
  vi.useFakeTimers(); const failed = vi.fn(async () => {}), effect = vi.fn();
  const call = vi.fn().mockRejectedValue(new TelegramApiError('network')), replies = new TelegramReplies(call);
  replies.deliver('123', 'Completed', { key: 'final', valid: () => true, failed }); effect();
  await vi.runAllTimersAsync();
  expect(effect).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(3); expect(failed).toHaveBeenCalledTimes(1);
  await replies.stop();
});
it('renders escaped bounded questions, terminal outcomes and a retained task link', () => {
  const waiting = renderTelegramTaskReply({ id: 'run-1', title: '<task> @all', status: 'waiting', privateChat: true,
    questions: [{ question: 'Choose <one>?', options: [{ label: 'A', description: 'Proceed & finish' }] }] });
  expect(waiting).toContain('&lt;task&gt; @​all'); expect(waiting).toContain('Choose &lt;one&gt;?'); expect(waiting).toContain('just type your answer');
  for (const status of ['done', 'review', 'cancelled', 'failed', 'expired']) {
    const text = renderTelegramTaskReply({ id: 'run-1', title: 'x'.repeat(10_000), status, error: 'e'.repeat(10_000), links: { pullRequest: 'https://example.test/task/1?a=1&b=2' } });
    expect(text.replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot);/g, 'x').length).toBeLessThanOrEqual(4096);
    expect(text).toContain('<a href="https://example.test/task/1?a=1&amp;b=2">Open pull request</a>');
  }
  expect(renderTelegramTaskReply({ id: 'run-1', title: 'x', status: 'done', result: 'Unchanged' })).toContain('Repository: Unchanged');
});

it('renders the agent’s final reply for a finished task and names the cockpit when it is shortened', () => {
  const short = renderTelegramTaskReply({ id: 'run-1', title: 'commit?', status: 'done', result: 'Unchanged', answer: 'Last commit: <feat> & @all' });
  expect(short).toContain('Agent: Last commit: &lt;feat&gt; &amp; @​all');
  expect(short.indexOf('Repository: Unchanged')).toBeLessThan(short.indexOf('Agent: '));
  expect(short).not.toContain('cockpit');
  for (const status of ['done', 'review']) {
    const long = renderTelegramTaskReply({ id: 'run-1', title: 't', status, answer: 'word '.repeat(2000), links: { pullRequest: 'https://example.test/pr/1' } });
    expect(long.length).toBeLessThanOrEqual(4096);
    expect(long).toContain('Agent: word word');
    expect(long).toContain('The full reply is in the cockpit.');
    expect(long).toContain('<a href="https://example.test/pr/1">Open pull request</a>');
  }
  // A failed or running notice ignores a reply; a structured question replaces it.
  for (const status of ['failed', 'running']) {
    expect(renderTelegramTaskReply({ id: 'run-1', title: 't', status, privateChat: true, answer: 'stray answer' })).not.toContain('stray answer');
  }
  expect(renderTelegramTaskReply({ id: 'run-1', title: 't', status: 'waiting', privateChat: true, answer: 'stray answer',
    questions: [{ question: 'Pick?' }] })).not.toContain('stray answer');
});

it('carries the agent’s reply on a waiting notice that ends in a free-text question', () => {
  const text = renderTelegramTaskReply({ id: 'run-1', title: 't', status: 'waiting', privateChat: true, excerpt: 'old excerpt',
    answer: 'Casablanca 21:43. Retry the fetch?' });
  expect(text).toContain('Agent: Casablanca 21:43. Retry the fetch?');
  expect(text).not.toContain('old excerpt');
  expect(text).toContain('just type your answer');
});

it('budgets the escaped HTML the dispatcher sends, so code-heavy results are never refused (#5)', async () => {
  const code = '<div class="a">&</div>\n'.repeat(400);
  for (const reply of [
    { id: 'run-1', title: 't', status: 'done', result: code, links: { pullRequest: 'https://example.test/' + 'p'.repeat(600) } },
    { id: 'run-1', title: 't', status: 'failed', error: code },
    { id: 'run-1', title: 't', status: 'waiting', privateChat: true, questions: [{ question: code }, { question: 'second' }] },
  ]) {
    const text = renderTelegramTaskReply(reply);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/Repository: &lt;div|Error: &lt;div|1\. &lt;div/);
    if (reply.status === 'waiting') expect(text).toContain('just type your answer');
    const replies = new TelegramReplies(async () => ({ message_id: 1 }));
    expect(replies.deliver('456', text, { valid: () => true })).toBe(true);
    await replies.stop();
  }
});

it.each([
  [{ state: 'policy_refused', policyReason: 'account_unavailable' }, 'saved account is unavailable'],
  [{ state: 'policy_refused', policyReason: 'provider_unavailable' }, 'task provider is unavailable'],
  [{ state: 'policy_refused', policyReason: 'project_unavailable' }, 'Send /task again'],
  [{ state: 'uncertain' }, 'cannot tell whether the task was created'],
  [{ state: 'expired' }, 'request expired'],
] as const)('renders source outcome %j without source prompt content', (outcome, expected) => {
  const text = renderTelegramSourceOutcome(outcome);
  expect(text).toContain(expected);
  expect(text).not.toContain('policyReason');
  expect(text).not.toContain('run-');
});
