import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelegramTaskTarget } from './task-target.ts';
import { createTelegramTask } from '../server/run-messages.ts';
import { randomUUID } from 'node:crypto';
import { NoticeThrottle, TelegramConversation, telegramAccessGrantedText, telegramHelp } from './conversation.ts';
import { TelegramActions } from './actions.ts';
import { formatTelegramText } from '../webhooks/telegram.ts';
import { freshState, InboundStateStore } from './state.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { TelegramUpdate } from './protocol.ts';
import type { TelegramTaskCreateResult } from '@open-mercato/cezar-contract';

function fixture() {
  const state = freshState('123', { projectId: 'project', installationId: 'instance', root: '/repo', generation: randomUUID() });
  const generation = randomUUID();
  state.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  state.grants.push({ id: randomUUID(), receiverId: 'receiver', chatId: '456', userId: '456', label: 'Person', permissions: ['respond', 'start'], capability: 'task_control', generation: randomUUID(), enableGeneration: generation, approvedAt: 0 });
  let disk = structuredClone(state);
  const store = new InboundStateStore(state, { assertOwner() {}, async write(next) { disk = structuredClone(next); }, now: () => 10_000 });
  const receiver = { id: 'receiver', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'],
    telegramChatId: '456', deliveryRevision: 1, url: 'https://api.telegram.org/bot123:synthetic/sendMessage', telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const run = { id: '12345678-abcd-4000-8000-123456789abc', title: '<b>Private @all</b>', status: 'waiting', archived: false, steps: [] } as unknown as RunRecord;
  const project = { id: 'project', root: '/nonexistent', store: { listRuns: () => [run], getRun: (id: string) => id === run.id ? run : undefined, redactRunText: (_id: string, text: string) => text } } as unknown as ProjectContext;
  const responses: string[] = []; const delivered: string[] = [];
  const context = vi.fn(async () => project);
  const deliver = vi.fn(async (_project: ProjectContext, _run: RunRecord, text: string, check: () => string | undefined) => {
    expect(disk.journal.at(-1)?.state).toBe('claimed');
    const error = check(); if (error) return { status: 409 as const, body: { error } };
    delivered.push(text); return { status: 200 as const, body: { delivered: true as const } };
  });
  const createTask = vi.fn(async (_project: ProjectContext, text: string, source: import('@open-mercato/cezar-contract').TelegramSourceRecord, check: () => string | undefined, _target: TelegramTaskTarget): Promise<TelegramTaskCreateResult> =>
    check() ? { created: false as const, reason: 'project_unavailable' as const } : { created: true as const, runId: source.runId ?? `new-${text.length}` });
  let clock = 10_000, messageId = 90;
  const keyboards: { messageId: number; buttons: { text: string; callback_data: string }[] }[] = [], receipts: Promise<void>[] = [];
  const actions = new TelegramActions({ botId: '123', state: store, call: async () => true, now: () => clock,
    reply: (_chat, text, valid) => { if (valid()) responses.push(text); } });
  const receivers = [receiver];
  const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: store, receiver: () => receiver, context, deliver,
    createTask, actions, receivers: () => receivers,
    episode: () => 'task-5', now: () => clock, reply: (_chat, text, valid, sent, keyboard) => {
      if (!valid()) return;
      responses.push(text); const id = ++messageId;
      if (keyboard) keyboards.push({ messageId: id, buttons: ('callback_data' in keyboard ? [[keyboard]] : keyboard).flat() });
      if (sent) receipts.push(sent({ message_id: id, chat: { id: 456 } }));
    } });
  const update = (text = '/reply 12345678 hello', update_id = 1, userId = 456): TelegramUpdate => ({ update_id, message: { message_id: 1, date: 10,
    chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0]!.length }] : [] } });
  /** Taps a button of the latest keyboard as Telegram would deliver it: a callback on the sent message. */
  const tap = async (index = 0, update_id = 50, from = 456, keyboard = keyboards.at(-1)!) => {
    await Promise.all(receipts);
    await actions.process({ update_id, callback_query: { id: `tap-${update_id}`, data: keyboard.buttons[index]!.callback_data, from: { id: from, is_bot: false },
      message: { message_id: keyboard.messageId, chat: { id: 456, type: 'private' } } } }, store.snapshot().epoch);
  };
  return { receivers, state: store, disk: () => disk, receiver, run, project, context, deliver, createTask, delivered, responses, conversation, update, actions, keyboards, tap,
    advance: (ms: number) => { clock += ms; } };
}
describe('Telegram conversation to task delivery', () => {
  it('redacts live receiver credentials from tasks, status and option buttons before clipping', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telegram-command-redaction-'));
    try {
      const x = fixture(), store = await RunStore.open(dir);
      x.project.store.redactRunText = store.redactRunText.bind(store);
      const secret = 'https://hooks.slack.com/services/T0000/B0000/rotatedReceiverCredential';
      x.receivers.push({ id: 'slack', format: 'slack.v1', url: secret } as PrivateReceiver);
      x.run.title = secret;
      x.run.attentionRequest = { requestId: 'question', askedAt: new Date().toISOString(), questions: [
        { question: secret, options: [{ label: secret, description: secret }, { label: 'Safe' }] },
      ] };
      await x.conversation.process(x.update('/tasks', 10), x.state.snapshot().epoch);
      await x.conversation.process(x.update('/status 12345678', 11), x.state.snapshot().epoch);
      expect(x.responses).toHaveLength(2);
      expect(x.keyboards).toHaveLength(1);
      expect(JSON.stringify([x.responses, x.keyboards])).not.toContain('rotatedReceiverCredential');
      expect(x.responses[1]).toContain('Tap an option');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(['stable', 'before confirmation', 'during provider gate'] as const)(
    'binds creation to the previewed runner: %s', async timing => {
      const root = await mkdtemp(join(tmpdir(), 'telegram-target-'));
      try {
        const dir = join(root, '.ai', 'cezar');
        await mkdir(dir, { recursive: true });
        const configure = (defaultRunner: string) => writeFile(join(dir, 'config.json'), JSON.stringify({ defaultRunner }));
        await configure('claude');
        const x = fixture(), startRun = vi.fn(() => ({ id: 'confirmed-run' }));
        x.project.root = root;
        x.project.manager = { startRun } as unknown as ProjectContext['manager'];
        const gate = vi.fn(async () => {
          if (timing === 'during provider gate') await configure('codex');
          return null;
        });
        x.createTask.mockImplementation((project, text, source, check, target) =>
          createTelegramTask(project, text, source, check, { providerActionError: gate }, target));
        await x.conversation.process(x.update('/task investigate', 9), x.state.snapshot().epoch);
        expect(x.responses[0]).toContain('Provider: claude');
        if (timing === 'before confirmation') await configure('codex');
        await x.tap(0, 10);
        await x.tap(0, 11);
        if (timing === 'stable') {
          expect(startRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ runner: 'claude' }));
        } else {
          expect(startRun).not.toHaveBeenCalled();
          // The runtime's source outcome is the one message about it; the conversation adds none.
          expect(x.responses.at(-1)).toContain('Start a new task?');
          expect(x.disk().sources[0]?.state).toBe('policy_refused');
          expect(gate).toHaveBeenCalledTimes(timing === 'before confirmation' ? 0 : 1);
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  it('answers bare private text with help and never starts a task', async () => {
    const x = fixture();
    await x.conversation.process(x.update('please investigate', 9), x.state.snapshot().epoch);
    expect(x.createTask).not.toHaveBeenCalled(); expect(x.context).toHaveBeenCalledOnce();
    expect(x.disk().sources).toEqual([]);
    expect(x.responses).toEqual([formatTelegramText(telegramHelp(), 4096, 'test_bot')]);
    expect(x.responses[0]!.split('\n')[0]).toBe('Just type to continue your current task: answer its question or send a follow-up.');
    expect(x.responses[0]).toContain('/task &lt;text&gt; — Start a new task (you confirm it first)');
    expect(x.disk().journal[0]).toMatchObject({ state: 'rejected', reason: 'unsupported' });
  });
  it('/task previews project, workflow and provider with Confirm and Cancel, and starts nothing', async () => {
    const x = fixture();
    await x.conversation.process(x.update('/task please <b>investigate</b>', 9), x.state.snapshot().epoch);
    expect(x.createTask).not.toHaveBeenCalled(); expect(x.disk().sources).toEqual([]);
    expect(x.responses[0]).toBe('Start a new task?\nProject: project\nWorkflow: quick-task\nProvider: claude\n'
      + 'The agent can run shell commands on this machine and may incur costs.\n\nplease &lt;b&gt;investigate&lt;/b&gt;');
    expect(x.keyboards[0]!.buttons.map(button => button.text)).toEqual(['Confirm', 'Cancel']);
    for (const button of x.keyboards[0]!.buttons) expect(button.callback_data).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(x.disk().journal[0]).toMatchObject({ kind: 'task', state: 'accepted', reason: 'preview' });
    expect(JSON.stringify(x.disk())).not.toContain('investigate');
  });
  it('creates exactly one task on Confirm, claimed on the tap and attributed to the /task message', async () => {
    const x = fixture(), epoch = x.state.snapshot().epoch;
    await x.conversation.process(x.update('/task please investigate', 9), epoch);
    await x.tap(0, 10); await x.tap(0, 11);
    await x.conversation.process(x.update('/task please investigate', 9), epoch);
    expect(x.createTask).toHaveBeenCalledTimes(1);
    expect(x.createTask.mock.calls[0]![1]).toBe('please investigate');
    expect(x.disk().sources).toHaveLength(1);
    expect(x.disk().sources[0]).toMatchObject({ projectId: 'project', receiverId: 'receiver', chatId: '456', userId: '456',
      sourceMessageId: 1, updateId: 10, state: 'finished' });
    expect(x.disk().sources[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(x.disk().journal.find(row => row.updateId === 10)).toMatchObject({ kind: 'task', state: 'accepted', reason: 'task_created' });
    expect(x.responses.at(-1)).toMatch(/^Started task [0-9a-f]{8}\.$/);
    expect(JSON.stringify(x.disk())).not.toContain('please investigate');
  });
  it.each(['account_unavailable', 'provider_unavailable', 'project_unavailable'] as const)(
    're-checks policy at Confirm and records %s as a terminal policy refusal', async (reason) => {
      const x = fixture();
      x.createTask.mockResolvedValueOnce({ created: false, reason });
      await x.conversation.process(x.update('/task please investigate', 10), x.state.snapshot().epoch);
      await x.tap(0, 11);
      expect(x.disk().sources[0]).toMatchObject({ state: 'policy_refused', policyReason: reason, updateId: 11 });
      expect(x.disk().journal.find(row => row.updateId === 11)).toMatchObject({ state: 'rejected', reason });
      expect(x.disk().nextOffset).toBe(12);
      // Source outcomes are delivered only by the durable runtime observer: the preview stays the only message.
      expect(x.responses).toHaveLength(1);
    });
  it.each(['cancel', 'expiry', 'other person', 'revoked grant', 'changed binding'])('starts no task after %s', async kind => {
    const x = fixture();
    await x.conversation.process(x.update('/task please investigate', 10), x.state.snapshot().epoch);
    if (kind === 'cancel') await x.tap(1, 11);
    if (kind === 'expiry') { x.advance(120_000); await x.tap(0, 11); }
    if (kind === 'other person') await x.tap(0, 11, 789);
    if (kind === 'revoked grant') { await x.state.change(state => { state.grants = []; }); await x.tap(0, 11); }
    if (kind === 'changed binding') { await x.state.change(state => { state.receivers[0]!.deliveryRevision = 2; }); await x.tap(0, 11); }
    expect(x.createTask).not.toHaveBeenCalled(); expect(x.disk().sources).toEqual([]);
    if (kind === 'cancel') {
      expect(x.responses.at(-1)).toBe('Not started.');
      expect(x.disk().journal.find(row => row.updateId === 11)).toMatchObject({ kind: 'task', state: 'rejected', reason: 'declined' });
      await x.tap(0, 12); expect(x.createTask).not.toHaveBeenCalled();
    }
    if (kind === 'other person') { await x.tap(0, 12); expect(x.createTask).toHaveBeenCalledTimes(1); }
  });
  it('re-checks the grant inside task creation, after the durable claim', async () => {
    const x = fixture();
    x.createTask.mockImplementationOnce(async (_project, _text, _source, check) => {
      await x.state.change(state => { state.grants[0]!.generation = randomUUID(); });
      return check() ? { created: false, reason: 'project_unavailable' } : { created: true, runId: 'never' };
    });
    await x.conversation.process(x.update('/task please investigate', 10), x.state.snapshot().epoch);
    await x.tap(0, 11);
    expect(x.disk().sources[0]).toMatchObject({ state: 'policy_refused', policyReason: 'project_unavailable' });
  });
  it('asks for a description after an empty /task and refuses /task in a group', async () => {
    const x = fixture();
    await x.conversation.process(x.update('/task   ', 10), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['Describe the task after /task, for example: /task fix the failing login test']);
    x.receiver.telegramChatId = '-123';
    await x.state.change(state => { state.receivers[0]!.chatId = '-123'; state.grants[0]!.chatId = '-123'; });
    const group = x.update('/task@test_bot build it', 11); group.message!.chat = { id: -123, type: 'group' };
    await x.conversation.process(group, x.state.snapshot().epoch);
    expect(x.responses.at(-1)).toBe('Start new tasks from your private chat with the bot.');
    expect(x.context).not.toHaveBeenCalled(); expect(x.keyboards).toEqual([]);
  });
  it('rejects a stale /task before opening project context, and reports an unavailable project', async () => {
    const x = fixture();
    await x.state.change(state => { state.grants[0]!.approvedAt = 20_000; });
    await x.conversation.process(x.update('/task please investigate', 11), x.state.snapshot().epoch);
    expect(x.context).not.toHaveBeenCalled(); expect(x.keyboards).toEqual([]);
    expect(x.disk().journal[0]).toMatchObject({ state: 'rejected', reason: 'expired' });
    expect(x.responses).toEqual(['This message is older than 15 minutes and was not carried out. Send it again.']);
    await x.state.change(state => { state.grants[0]!.approvedAt = 0; });
    x.context.mockRejectedValueOnce(new Error('project unavailable'));
    await x.conversation.process(x.update('/task please investigate', 12), x.state.snapshot().epoch);
    expect(x.responses.at(-1)).toBe('The project is unavailable. Nothing was run.');
    expect(x.disk().sources).toEqual([]); expect(x.keyboards).toEqual([]);
  });
  it('durably claims before effect, prefixes text, stores result before acknowledging and deduplicates', async () => {
    const x = fixture(), update = x.update(), epoch = x.state.snapshot().epoch;
    await x.conversation.process(update, epoch); await x.conversation.process(update, epoch);
    expect(x.delivered).toEqual(['[via Telegram] hello']);
    expect(x.disk().journal.at(-1)).toMatchObject({ state: 'accepted', runId: x.run.id });
    expect(x.disk().nextOffset).toBe(2);
    // Markup in run text is not a path: only private roots are scrubbed (G2).
    expect(x.responses).toEqual(['Delivered to task 12345678 · &lt;b&gt;Private @​all&lt;/b&gt;.']);
    expect(JSON.stringify(x.disk())).not.toContain('hello');
  });
  it('routes ordinary private text to the current waiting task context', async () => {
    const x = fixture();
    x.run.telegramSource = { botId: '123', chatId: '456', userId: '456', createdAt: 20 } as RunRecord['telegramSource'];
    await x.conversation.process(x.update('ordinary answer'), x.state.snapshot().epoch);
    expect(x.delivered).toEqual(['[via Telegram] ordinary answer']);
    expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'answer', state: 'accepted', reason: 'delivered' });
  });
  it('does not open a project for an ungranted person', async () => {
    const x = fixture(); await x.conversation.process(x.update('/tasks', 1, 789), x.state.snapshot().epoch);
    expect(x.context).not.toHaveBeenCalled(); expect(x.delivered).toEqual([]);
    expect(x.responses.join(' ')).not.toContain('Private');
  });
  it('rechecks grant after asynchronous project recovery', async () => {
    const x = fixture(); x.context.mockImplementationOnce(async () => { await x.state.change(state => { state.grants = []; }); return x.project; });
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    expect(x.delivered).toEqual([]); expect(x.disk().journal.at(-1)?.state).toBe('rejected');
  });
  it('uses the current durable grant freshness after project recovery', async () => {
    const x = fixture();
    x.context.mockImplementationOnce(async () => {
      await x.state.change(state => { state.grants[0]!.approvedAt = 20_000; });
      return x.project;
    });
    await x.conversation.process(x.update('/task please investigate', 13), x.state.snapshot().epoch);
    expect(x.keyboards).toEqual([]);
    expect(x.disk().journal[0]).toMatchObject({ state: 'rejected', reason: 'expired' });
    expect(x.responses).toEqual(['This message is older than 15 minutes and was not carried out. Send it again.']);
  });
  it('does not revive finished runs and rejects unknown commands instead of passing to agent', async () => {
    const x = fixture(); x.run.status = 'done';
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    await x.conversation.process(x.update('/shell rm', 2), x.state.snapshot().epoch);
    expect(x.delivered).toEqual([]); expect(x.disk().journal.map(entry => entry.state)).toEqual(['rejected', 'rejected']);
  });
  it('marks an ambiguous delivery exception uncertain and never retries the action', async () => {
    const x = fixture(); x.deliver.mockRejectedValueOnce(new Error('possibly delivered secret'));
    const update = x.update(), epoch = x.state.snapshot().epoch;
    await x.conversation.process(update, epoch); await x.conversation.process(update, epoch);
    expect(x.deliver).toHaveBeenCalledTimes(1); expect(x.disk().journal.at(-1)?.state).toBe('uncertain');
    expect(JSON.stringify(x.disk())).not.toContain('possibly delivered secret');
  });
  it('requires current Reply correlation; never falls back to an arbitrary waiting task', async () => {
    const x = fixture(), message = x.update('yes'); message.message!.reply_to_message = { message_id: 5 };
    await x.conversation.process(message, x.state.snapshot().epoch); expect(x.delivered).toEqual([]);
    await x.state.change(state => { state.correlations.push({ receiverId: 'receiver', chatId: '456', messageId: 5, deliveryRevision: 1,
      bindingGeneration: state.binding.generation, enableGeneration: state.receivers[0]!.generation, runId: x.run.id,
      type: 'task.attention_required', sequence: 5, episodeId: 'task-5', continuation: 0, createdAt: 10_000 }); });
    await x.conversation.process({ ...message, update_id: 2 }, x.state.snapshot().epoch);
    expect(x.delivered).toEqual(['[via Telegram] yes']);
  });
it('renders task status as escaped redacted text with prose-question limitation', async () => {
    const x = fixture(); await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    expect(x.responses.join(' ')).toContain('&lt;b&gt;'); expect(x.responses.join(' ')).not.toContain('<b>Private');
    expect(x.responses.join(' ')).toContain('Reply to this message'); expect(x.delivered).toEqual([]);
  });
  it('ignores messages addressed to another bot without opening context', async () => {
    const x = fixture(); await x.conversation.process(x.update('/reply@other 12345678 hello'), x.state.snapshot().epoch);
    expect(x.context).not.toHaveBeenCalled(); expect(x.responses).toEqual([]); await x.state.flush(); expect(x.disk().nextOffset).toBe(2);
  });
  it('rejects stale and oversized input without truncating it into an agent command', async () => {
    const x = fixture(), stale = x.update(); stale.message!.date = 1000;
    await x.conversation.process(stale, x.state.snapshot().epoch);
    await x.conversation.process(x.update('/reply 12345678 ' + 'x'.repeat(4001), 2), x.state.snapshot().epoch);
    expect(x.delivered).toEqual([]); expect(x.context).not.toHaveBeenCalled();
  });

  it('bounds lazy project recovery at 30 seconds and records no delivery', async () => {
    vi.useFakeTimers();
    try {
      const x = fixture();
      let release!: () => void;
      x.context.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(x.project); }));
      const processing = x.conversation.process(x.update('/task please investigate'), x.state.snapshot().epoch);
      await vi.advanceTimersByTimeAsync(0);
      expect(x.context).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      await processing;
      expect(x.delivered).toEqual([]);
      expect(x.disk().journal.at(-1)).toMatchObject({ state: 'rejected', reason: 'context_unavailable' });
      expect(x.disk().sources).toEqual([]);
      release?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
it('does not expose an unknown lifecycle code in task status', async () => {
  const x = fixture(); x.run.status = 'future_state' as RunRecord['status'];
  await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
  expect(x.responses.join(' ')).toContain('Status unavailable');
  expect(x.responses.join(' ')).not.toContain('future_state');
});
it('accepts 4000 UTF-16 units of /reply content without counting the command and task reference', async () => {
  const x = fixture(), text = 'a'.repeat(4000);
  await x.conversation.process(x.update(`/reply ${x.run.id} ${text}`), x.state.snapshot().epoch);
  expect(x.delivered).toEqual([`[via Telegram] ${text}`]);
});
it('budgets /tasks by whole escaped lines so a task ID is never cut at the output limit', async () => {
  const x = fixture();
  const runs = Array.from({ length: 10 }, (_, i) => ({ ...x.run, id: `12345678-abcd-4000-8000-${String(i).padStart(12, '0')}`, title: '&'.repeat(180) }));
  vi.spyOn(x.project.store, 'listRuns').mockReturnValue(runs);
  await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
  expect(x.responses[0]!.split('\n')).toHaveLength(4);
  expect(x.responses[0]!.split('\n')[0]).toBe('12345678 · Waiting for your answer · ' + '&amp;'.repeat(180));
});
it('group grants accept explicitly addressed commands but not ambient messages, other bots or private commands', async () => {
  const x = fixture(); x.receiver.telegramChatId = '-123';
  await x.state.change(state => { state.receivers[0]!.chatId = '-123'; state.grants[0]!.chatId = '-123'; });
  for (const [index, text] of ['/tasks', 'ambient discussion', '/tasks@other_bot'].entries()) {
    const update = x.update(text, index + 1); update.message!.chat = { id: -123, type: 'group' };
    await x.conversation.process(update, x.state.snapshot().epoch);
  }
  expect(x.context).not.toHaveBeenCalled(); expect(x.responses).toEqual([]);
  await x.conversation.process(x.update('/tasks', 4), x.state.snapshot().epoch);
  expect(x.context).not.toHaveBeenCalled();
  const addressed = x.update('/reply@test_bot 12345678 yes', 5); addressed.message!.chat = { id: -123, type: 'group' };
  await x.conversation.process(addressed, x.state.snapshot().epoch);
  expect(x.delivered).toEqual(['[via Telegram] yes']);
});

it.each([false, true])('checks real grant revocation (%s) between control preview and click', async revoked => {
  const { TelegramActions } = await import('./actions.ts');
  const { prepareTelegramControl } = await import('./controls.ts');
  const x = fixture(); x.run.status = 'done'; x.run.runner = 'codex'; x.run.agentProfile = 'default';
  x.run.steps = [{ sessionId: 'session', backend: 'codex', profileId: 'default' }] as RunRecord['steps'];
  const resume = vi.fn(() => { x.run.status = 'running'; return { ok: true }; });
  Object.assign(x.project, { root: '/nonexistent', manager: { continueRun: resume } });
  await x.state.change(state => { state.grants[0]!.permissions.push('continue'); });
  const sent: Promise<void>[] = [], buttons: string[] = [], responses: string[] = [];
  const actions = new TelegramActions({ botId: '123', state: x.state, call: async () => true, now: () => 10_000,
    reply: (_chat, text, valid) => { if (valid()) responses.push(text); } });
  const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: x.state, receiver: () => x.receiver, receivers: () => x.receivers,
    context: x.context, deliver: x.deliver, episode: () => undefined, now: () => 10_000, actions,
    prepareControl: (project, run, kind, text) => prepareTelegramControl(project, run, kind, text, {
      providerActionError: async () => null, resolveProfile: async () => ({ profile: { id: 'default' } }), resolveAttachments: () => [],
    }),
    reply: (_chat, text, valid, receipt, button) => { if (valid()) {
      responses.push(text); if (button && 'callback_data' in button) buttons.push(button.callback_data);
      if (receipt) sent.push(receipt({ message_id: 99, chat: { id: 456 } }));
    } },
  });
  const epoch = x.state.snapshot().epoch;
  await conversation.process(x.update('/continue 12345678 private-followup-text'), epoch); await Promise.all(sent);
  expect(resume).not.toHaveBeenCalled(); expect(buttons).toHaveLength(1);
  expect(responses[0]).toContain('costs');
  await x.state.change(state => {
    // An unrelated configuration edit must not invalidate this person's preview.
    state.configGeneration = randomUUID();
    if (revoked) { state.grants[0]!.permissions = ['respond']; state.grants[0]!.generation = randomUUID(); }
  });
  const click: TelegramUpdate = { update_id: 2, callback_query: { id: 'click', data: buttons[0], from: { id: 456, is_bot: false },
    message: { message_id: 99, chat: { id: 456, type: 'private' } } } };
  await actions.process(click, epoch);
  expect(resume).toHaveBeenCalledTimes(revoked ? 0 : 1);
  if (!revoked) {
    expect(responses.at(-1)).toBe('Continuing task 12345678.');
    expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'continue', state: 'accepted' });
  }
  await actions.process({ ...click, update_id: 3 }, epoch); expect(resume).toHaveBeenCalledTimes(revoked ? 0 : 1);
  expect(JSON.stringify(x.disk())).not.toContain('private-followup-text');
});

it.each(['cancel', 'continue'])('requires separate %s permission before preparing a preview', async kind => {
  const { TelegramActions } = await import('./actions.ts');
  const x = fixture(), prepareControl = vi.fn(async () => undefined);
  const actions = new TelegramActions({ botId: '123', state: x.state, call: async () => true, reply: () => {} });
  const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: x.state, receiver: () => x.receiver, receivers: () => x.receivers,
    context: x.context, deliver: x.deliver, episode: () => undefined, reply: () => {}, now: () => 10_000, actions, prepareControl });
  await conversation.process(x.update(`/${kind} 12345678`), x.state.snapshot().epoch);
  expect(prepareControl).not.toHaveBeenCalled(); expect(x.deliver).not.toHaveBeenCalled();
  await x.state.flush();
  // A paired person's refusal keeps actor and kind instead of folding into the anonymous summary.
  expect(x.disk().journal.at(-1)).toMatchObject({ state: 'rejected', reason: 'permission_denied', kind, userId: '456' });
  expect(x.disk().journal.some(row => row.kind === 'rejection_summary')).toBe(false);
});

describe('Telegram conversation copy', () => {
  it('answers /help from the bot menu and journals it as help, not an unknown command', async () => {
    const x = fixture();
    await x.conversation.process(x.update('/help', 1), x.state.snapshot().epoch);
    expect(x.responses).toEqual([formatTelegramText(telegramHelp(), 4096, 'test_bot')]);
    expect(x.disk().journal[0]).toMatchObject({ kind: 'help', state: 'accepted', reason: 'read' });
  });
  it('/status without an ID shows the sender’s latest Telegram task, never anyone else’s', async () => {
    const x = fixture();
    const own = (id: string, createdAt: string, userId = '456') => ({ id, title: `own ${id.slice(0, 8)}`, status: 'done', archived: false, steps: [], createdAt,
      telegramSource: { botId: '123', chatId: '456', userId, projectId: 'project' } } as unknown as RunRecord);
    const older = own('aaaaaaaa-0000-4000-8000-000000000001', '2026-11-01T10:00:00Z'), newer = own('bbbbbbbb-0000-4000-8000-000000000002', '2026-11-02T10:00:00Z');
    const other = own('cccccccc-0000-4000-8000-000000000003', '2026-11-03T10:00:00Z', '999');
    const store = x.project.store as unknown as { listRuns(): RunRecord[]; getRun(id: string): RunRecord | undefined };
    let runs = [x.run, older, newer, other];
    store.listRuns = () => runs; store.getRun = id => runs.find(run => run.id === id);
    await x.conversation.process(x.update('/status'), x.state.snapshot().epoch);
    expect(x.responses[0]).toContain('Task bbbbbbbb'); expect(x.responses[0]).toContain('own bbbbbbbb');
    expect(x.disk().journal.at(-1)).toMatchObject({ state: 'accepted', runId: newer.id });
    runs = [x.run, other];
    await x.conversation.process(x.update('/status', 2), x.state.snapshot().epoch);
    expect(x.responses[1]).toContain('You have not started a task from this chat yet');
    expect(x.responses[1]).not.toContain('cccccccc');
    expect(x.disk().journal.at(-1)).toMatchObject({ state: 'rejected', reason: 'unknown_task' });
  });
  it('scrubs local paths from run text in /status and /tasks', async () => {
    const x = fixture();
    Object.assign(x.run, { title: 'fix /home/alice/clients/acme-secret/login.ts', error: "ENOENT: open '/home/alice/clients/acme-secret/.env.production'",
      attentionRequest: { requestId: 'request-1', askedAt: new Date(0).toISOString(), questions: [{ question: 'Edit /home/alice/notes.md?',
        options: [{ label: 'yes /home/alice/a', description: 'see /home/alice/b' }, { label: 'no' }] }] } });
    await x.conversation.process(x.update('/status 12345678', 1), x.state.snapshot().epoch);
    await x.conversation.process(x.update('/tasks', 2), x.state.snapshot().epoch);
    expect(x.responses).toHaveLength(2);
    for (const response of x.responses) { expect(response).toContain('fix …'); expect(response).not.toContain('/home/'); }
    for (const button of x.keyboards.flatMap(row => row.buttons)) expect(button.text).not.toContain('/home/');
    // Fixed hints keep their command names.
    expect(x.responses[0]).toContain('Reply to this message to answer task 12345678.');
  });
  it('lists waiting tasks first and hides dispatch children that need nothing', async () => {
    const x = fixture(), run = (n: number, status: string, extra = {}) => ({ ...x.run, id: `${n}0000000-abcd-4000-8000-000000000000`, title: `T${n}`, status, ...extra }) as RunRecord;
    vi.spyOn(x.project.store, 'listRuns').mockReturnValue([run(1, 'done'), run(2, 'running', { dispatch: { parentRunId: 'p' } }), run(3, 'waiting'), run(4, 'waiting', { dispatch: { parentRunId: 'p' } })]);
    await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
    expect(x.responses[0]!.split('\n').map(line => line.split(' · ')[2])).toEqual(['T3', 'T4', 'T1']);
  });
  it('caps /tasks at ten lines', async () => {
    const x = fixture();
    vi.spyOn(x.project.store, 'listRuns').mockReturnValue(Array.from({ length: 15 }, (_, i) => ({ ...x.run, id: `${String(i).padStart(8, '0')}-abcd-4000-8000-000000000000`, title: 't' })));
    await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
    expect(x.responses[0]!.split('\n')).toHaveLength(10);
  });
  it('tells a paired person with paused access that replies are off instead of asking to pair', async () => {
    const x = fixture(); await x.state.change(state => { state.receivers[0]!.enabled = false; });
    await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['Replies are currently off for this chat. Check the cezar cockpit.']);
  });
  it('keeps the pairing hint for private strangers but stays silent for strangers in an unbound group', async () => {
    const x = fixture();
    const group = x.update('/tasks@test_bot', 1, 789); group.message!.chat = { id: -999, type: 'group' };
    await x.conversation.process(group, x.state.snapshot().epoch);
    expect(x.responses).toEqual([]);
    await x.conversation.process(x.update('/tasks', 2, 789), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['To control tasks, start pairing in the cezar cockpit.']);
  });
  it('asks for the answer when /reply has only a task ID', async () => {
    const x = fixture(); await x.conversation.process(x.update('/reply 12345678'), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['Add your answer after the task ID.']); expect(x.delivered).toEqual([]);
  });
  it('points a reply to a finished task at the cockpit when the person may not continue it', async () => {
    const x = fixture(); x.run.status = 'done';
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    expect(x.responses[0]).toContain('Task 12345678 is completed and no longer waiting'); expect(x.responses[0]).toContain('Resume it in the cockpit.');
    expect(x.responses[0]).not.toContain('/continue');
  });
  it('keeps ordinary private text in the finished task context and previews a continuation', async () => {
    const x = fixture(); x.run.status = 'done';
    x.run.telegramSource = { botId: '123', chatId: '456', userId: '456', createdAt: 20 } as RunRecord['telegramSource'];
    await x.state.change(state => { state.grants[0]!.permissions = ['respond', 'continue']; });
    const prepareControl = vi.fn(async () => ({ summary: 'Continue task?', valid: () => true, execute: async () => true }));
    const actions = new TelegramActions({ botId: '123', state: x.state, call: async () => true, now: () => 10_000, reply: () => {} });
    const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: x.state, receiver: () => x.receiver,
      receivers: () => x.receivers, context: x.context, deliver: x.deliver, episode: () => undefined, now: () => 10_000, actions, prepareControl,
      reply: (_chat, text, valid, _sent, keyboard) => {
        if (!valid()) return;
        x.responses.push(text);
        if (keyboard) x.keyboards.push({ messageId: 1, buttons: ('callback_data' in keyboard ? [[keyboard]] : keyboard).flat() });
      } });

    await conversation.process(x.update('a follow-up question'), x.state.snapshot().epoch);

    expect(prepareControl).toHaveBeenCalledWith(x.project, x.run, 'continue', 'a follow-up question');
    expect(x.responses[0]).toContain('Continue task?');
    expect(x.keyboards[0]?.buttons.map(button => button.text)).toEqual(['Confirm']);
    expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'continue', reason: 'preview' });
  });
  it('points a reply to a finished task at /continue when the person may continue it', async () => {
    const x = fixture(); x.run.status = 'done';
    await x.state.change(state => { state.grants[0]!.permissions = ['respond', 'continue']; });
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    expect(x.responses[0]).toContain('Resume it in the cockpit or with /continue 12345678 &lt;text&gt;.');
  });
  it('uses the @bot suffix in group help and hints', async () => {
    const x = fixture(); x.receiver.telegramChatId = '-123';
    await x.state.change(state => { state.receivers[0]!.chatId = '-123'; state.grants[0]!.chatId = '-123'; });
    const update = x.update('/help@test_bot'); update.message!.chat = { id: -123, type: 'group' };
    await x.conversation.process(update, x.state.snapshot().epoch);
    expect(x.responses[0]).toContain('/tasks@test_bot'); expect(x.responses[0]).toContain('/reply@test_bot');
    expect(telegramAccessGrantedText('-123', 'test_bot')).toContain('/tasks@test_bot');
    expect(telegramAccessGrantedText('456', 'test_bot')).toContain('Try /tasks ');
  });
  it('throttles notices per key inside the window', () => {
    let now = 0; const throttle = new NoticeThrottle(() => now);
    expect(throttle.allow('pairing:1')).toBe(true); expect(throttle.allow('pairing:1')).toBe(false); expect(throttle.allow('pairing:2')).toBe(true);
    now = 60_000; expect(throttle.allow('pairing:1')).toBe(true);
  });
});

describe('Telegram option buttons for a structured question', () => {
  const ask = (x: ReturnType<typeof fixture>, questions: NonNullable<RunRecord['attentionRequest']>['questions']) => {
    x.run.attentionRequest = { requestId: 'request-1', askedAt: '2026-10-31T10:00:00.000Z', questions };
  };
  const single = [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'release' }, { label: 'r'.repeat(120) }] }];
  it('offers one button per option carrying only an ephemeral action id', async () => {
    const x = fixture(); ask(x, single);
    await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    const buttons = x.keyboards[0]!.buttons;
    expect(buttons.map(button => button.text)).toEqual(['main', 'release', `${'r'.repeat(63)}…`]);
    for (const button of buttons) {
      expect(button.callback_data).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      expect(button.callback_data).not.toContain(x.run.id.slice(0, 8));
    }
    expect(new Set(buttons.map(button => button.callback_data)).size).toBe(3);
    expect(x.responses[0]).toContain('Tap an option below');
    expect(x.delivered).toEqual([]);
  });
  it('numbers options whose scrubbed labels collide, in buttons and bullets alike, and delivers the full label (G2)', async () => {
    const x = fixture(); ask(x, [{ question: 'Which file?', options: [{ label: 'Use /home/a/x' }, { label: 'Use /home/a/y' }] }]);
    await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    expect(x.keyboards[0]!.buttons.map(button => button.text)).toEqual(['1. Use …', '2. Use …']);
    expect(x.responses[0]).toContain('1. Use …\n2. Use …');
    await x.tap(1, 10);
    expect(x.delivered).toEqual(['[via Telegram] Use /home/a/y']);
  });
  it('keeps distinct option labels unnumbered (G2)', async () => {
    const x = fixture(); ask(x, [{ question: 'Which route?', options: [{ label: 'Fix /status' }, { label: 'Fix /api/v1/runs' }] }]);
    await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    expect(x.keyboards[0]!.buttons.map(button => button.text)).toEqual(['Fix /status', 'Fix /api/v1/runs']);
  });
  it('delivers the tapped label through the Reply path exactly once', async () => {
    const x = fixture(); ask(x, single);
    await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    await x.tap(2, 10); await x.tap(0, 11);
    expect(x.delivered).toEqual([`[via Telegram] ${'r'.repeat(120)}`]);
    expect(x.deliver).toHaveBeenCalledTimes(1);
    expect(x.disk().journal.find(row => row.updateId === 10)).toMatchObject({ kind: 'answer', runId: x.run.id, state: 'accepted', reason: 'delivered' });
    expect(x.responses.at(-1)).toBe('Delivered to task 12345678 · &lt;b&gt;Private @​all&lt;/b&gt;.');
    expect(JSON.stringify(x.disk())).not.toContain('rrrr');
  });
  it.each(['new episode', 'new question', 'answered in the cockpit', 'revoked grant', 'other person', 'expiry'])(
    'refuses a stale tap after %s and delivers nothing', async kind => {
      const x = fixture(); ask(x, single);
      let episode = 'task-5';
      (x.conversation as unknown as { deps: { episode: () => string } }).deps.episode = () => episode;
      await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
      if (kind === 'new episode') episode = 'task-6';
      if (kind === 'new question') x.run.attentionRequest = { ...x.run.attentionRequest!, requestId: 'request-2' };
      if (kind === 'answered in the cockpit') x.run.status = 'running';
      if (kind === 'revoked grant') await x.state.change(state => { state.grants = []; });
      if (kind === 'expiry') x.advance(15 * 60_000);
      await x.tap(0, 10, kind === 'other person' ? 789 : 456);
      expect(x.deliver).not.toHaveBeenCalled();
      // A refused tap is acknowledged and journaled like any unavailable button, never as an answer.
      expect(x.state.snapshot().journal.some(row => row.kind === 'answer')).toBe(false);
      expect(x.state.snapshot().journal.at(-1)).toMatchObject({ kind: 'rejection_summary', reason: 'unauthorized' });
    });
  it('refuses a question that turns stale between the tap and delivery', async () => {
    const x = fixture(); ask(x, single);
    await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    x.deliver.mockImplementationOnce(async (_project, _run, _text, check) => {
      x.run.attentionRequest = { ...x.run.attentionRequest!, requestId: 'request-2' };
      const error = check(); return error ? { status: 409 as const, body: { error } } : { status: 200 as const, body: { delivered: true as const } };
    });
    await x.tap(0, 10);
    expect(x.delivered).toEqual([]);
    expect(x.disk().journal.find(row => row.updateId === 10)).toMatchObject({ kind: 'answer', state: 'rejected', reason: 'delivery_refused' });
  });
  it.each([
    ['a multi-select question', [{ question: 'Which checks?', multiSelect: true as const, options: [{ label: 'lint' }, { label: 'test' }] }], 'accepts several options'],
    ['several questions', [single[0]!, { question: 'Which runner?', options: [{ label: 'codex' }] }], undefined],
    ['a question without options', [{ question: 'Anything else?' }], undefined],
  ])('offers no buttons for %s', async (_name, questions, note) => {
    const x = fixture(); ask(x, questions);
    await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    expect(x.keyboards).toEqual([]);
    expect(x.responses[0]).not.toContain('Tap an option');
    if (note) expect(x.responses[0]).toContain(note);
    expect(x.responses[0]).toContain('Reply to this message to answer task 12345678.');
  });
});

describe('Telegram conversation context and follow-ups', () => {
  type Deps = { member?: (chatId: string, userId: string) => Promise<boolean | undefined>; prepareControl?: unknown };
  const deps = (x: ReturnType<typeof fixture>) => (x.conversation as unknown as { deps: Deps }).deps;
  const inGroup = async (x: ReturnType<typeof fixture>) => {
    x.receiver.telegramChatId = '-123';
    await x.state.change(state => { state.receivers[0]!.chatId = '-123'; state.grants[0]!.chatId = '-123'; });
  };
  const groupUpdate = (x: ReturnType<typeof fixture>, text: string, id: number, userId = 456) => {
    const update = x.update(text, id, userId); update.message!.chat = { id: -123, type: 'group' }; return update;
  };
  const correlate = (x: ReturnType<typeof fixture>, type: string, messageId: number, chatId = '456') => x.state.change(state => {
    state.correlations.push({ receiverId: 'receiver', chatId, messageId, deliveryRevision: 1, bindingGeneration: state.binding.generation,
      enableGeneration: state.receivers[0]!.generation, runId: x.run.id, type, sequence: 2, episodeId: 'task-5', continuation: 0, createdAt: 10_000 });
  });
  const continuable = async (x: ReturnType<typeof fixture>) => {
    x.run.status = 'done';
    await x.state.change(state => { state.grants[0]!.permissions = ['respond', 'continue']; });
    const prepareControl = vi.fn(async (_project: ProjectContext, _run: RunRecord, _kind: string, text: string) =>
      ({ summary: `Continue task 12345678?\n\nMessage:\n${text}`, valid: () => true, execute: async () => true }));
    deps(x).prepareControl = prepareControl;
    return prepareControl;
  };

  it('refuses /task without the Start permission and names it', async () => {
    const x = fixture();
    await x.state.change(state => { state.grants[0]!.permissions = ['respond']; });
    await x.conversation.process(x.update('/task build it', 9), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['Starting tasks from Telegram needs the Start permission. Ask the cezar operator to turn it on in the cockpit.']);
    expect(x.context).not.toHaveBeenCalled(); expect(x.keyboards).toEqual([]);
    expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'task', state: 'rejected', reason: 'permission_denied' });
  });
  it('queues text sent while the context task is still working, instead of calling it out of date', async () => {
    const x = fixture(); x.run.status = 'running';
    x.run.telegramSource = { botId: '123', chatId: '456', userId: '456', createdAt: 20 } as RunRecord['telegramSource'];
    x.deliver.mockImplementationOnce(async (_project, _run, text, check) => {
      if (check()) return { status: 409 as const, body: { error: 'refused' } };
      x.delivered.push(text); return { status: 200 as const, body: { queued: true as const } } as never;
    });
    await x.conversation.process(x.update('also update the docs'), x.state.snapshot().epoch);
    expect(x.delivered).toEqual(['[via Telegram] also update the docs']);
    expect(x.responses).toEqual(['Queued for task 12345678 · &lt;b&gt;Private @​all&lt;/b&gt;: the agent reads it after its current step.']);
    expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'answer', state: 'queued', reason: 'queued' });
  });
  it('opens the same Continue preview for a Reply to the final notice as for plain text', async () => {
    const x = fixture(), prepareControl = await continuable(x);
    await correlate(x, 'source-final:source-1', 7);
    const reply = x.update('one more thing', 9); reply.message!.reply_to_message = { message_id: 7 };
    await x.conversation.process(reply, x.state.snapshot().epoch);
    expect(prepareControl).toHaveBeenCalledWith(x.project, x.run, 'continue', 'one more thing');
    expect(x.keyboards[0]!.buttons.map(button => button.text)).toEqual(['Confirm']);
    expect(x.responses[0]).toContain('one more thing');
    expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'continue', state: 'accepted', reason: 'preview' });
  });
  it('makes an explicitly addressed task the private context, but not in a group', async () => {
    const x = fixture();
    await x.conversation.process(x.update('/status 12345678', 9), x.state.snapshot().epoch);
    expect(x.disk().contexts).toEqual([{ receiverId: 'receiver', chatId: '456', userId: '456', runId: x.run.id, at: 10_000 }]);
    const y = fixture(); await inGroup(y);
    await y.conversation.process(groupUpdate(y, '/status@test_bot 12345678', 9), y.state.snapshot().epoch);
    expect(y.responses[0]).toContain('Task 12345678');
    expect(y.disk().contexts).toBeUndefined();
  });
  it('stays silent in a group for Replies that match no bot notice, from members and strangers alike', async () => {
    const x = fixture(); await inGroup(x);
    for (const [index, userId] of [456, 789].entries()) {
      const reply = groupUpdate(x, 'I agree with you', index + 1, userId); reply.message!.reply_to_message = { message_id: 5 };
      await x.conversation.process(reply, x.state.snapshot().epoch);
    }
    expect(x.responses).toEqual([]); expect(x.context).not.toHaveBeenCalled();
    await correlate(x, 'task.attention_required', 6, '-123');
    const reply = groupUpdate(x, 'yes', 3); reply.message!.reply_to_message = { message_id: 6 };
    await x.conversation.process(reply, x.state.snapshot().epoch);
    expect(x.delivered).toEqual(['[via Telegram] yes']);
  });
  it('asks an unapproved group member to see the operator, never to start pairing, and offers no bare /status', async () => {
    const x = fixture(); await inGroup(x);
    await x.conversation.process(groupUpdate(x, '/tasks@test_bot', 1, 789), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['Ask the cezar operator to approve you for task control in this group.']);
    await x.conversation.process(groupUpdate(x, '/status@test_bot', 2), x.state.snapshot().epoch);
    expect(x.responses.at(-1)).toBe('Add a task ID: /status@test_bot &lt;task&gt;. Use /tasks@test_bot to list tasks.');
    expect(telegramHelp('test_bot')).toContain('/status@test_bot <task> —');
    expect(telegramHelp('test_bot')).not.toContain('[task]');
  });
  it.each([[false, 'no longer a member'], [undefined, 'Could not confirm your group membership']] as const)(
    're-checks group membership before acting (%s)', async (member, text) => {
      const x = fixture(); await inGroup(x);
      const check = vi.fn(async (): Promise<boolean | undefined> => member); deps(x).member = check;
      await x.conversation.process(groupUpdate(x, '/reply@test_bot 12345678 yes', 1), x.state.snapshot().epoch);
      expect(check).toHaveBeenCalledWith('-123', '456');
      expect(x.delivered).toEqual([]); expect(x.context).not.toHaveBeenCalled();
      expect(x.responses[0]).toContain(text);
      check.mockResolvedValue(true);
      await x.conversation.process(groupUpdate(x, '/reply@test_bot 12345678 yes', 2), x.state.snapshot().epoch);
      expect(x.delivered).toEqual(['[via Telegram] yes']);
    });
  it('never re-checks membership in a private chat', async () => {
    const x = fixture(), check = vi.fn(async () => false); deps(x).member = check;
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    expect(check).not.toHaveBeenCalled(); expect(x.delivered).toEqual(['[via Telegram] hello']);
  });
});
