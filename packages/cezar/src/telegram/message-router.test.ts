import { describe, expect, it } from 'vitest';
import { classifyTelegramMessage, type RouterContext } from './message-router.ts';
import type { TelegramUpdate } from './protocol.ts';
import { randomUUID } from 'node:crypto';
import type { InboundState, Correlation } from './state.ts';
import type { RunRecord } from '../runs/store.ts';

function mockUpdate(text: string, chatType: 'private' | 'group' = 'private', replyToMessageId?: number): TelegramUpdate {
  const isCommand = text.startsWith('/');
  return {
    update_id: 1,
    message: {
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatType === 'private' ? 123 : -456, type: chatType },
      from: { id: 123, is_bot: false },
      text,
      ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0]!.length }] } : {}),
      ...(replyToMessageId ? { reply_to_message: { message_id: replyToMessageId } } : {}),
    },
  };
}

/** The receiver binding's enable generation; a routable correlation carries it. */
const ENABLED = randomUUID();
function mockState(chatId: string, correlations: Correlation[] = []): InboundState {
  return {
    schemaVersion: 1,
    botId: '123',
    binding: { projectId: 'proj', installationId: 'inst', root: '/repo', generation: randomUUID() },
    configGeneration: randomUUID(),
    receivers: [{ receiverId: 'recv', chatId, enabled: true, generation: ENABLED, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) }],
    grants: [],
    epoch: randomUUID(),
    phase: 'active',
    nextOffset: 0,
    lastUpdateAt: Date.now(),
    correlations,
    sources: [],
    journal: [],
  };
}

function mockRuns(waiting: string[] = []): RunRecord[] {
  return waiting.map(id => ({
    id,
    status: 'waiting',
    archived: false,
    title: `Task ${id}`,
    steps: [],
  } as unknown as RunRecord));
}

function mockContext(chatId: string, runs: RunRecord[] = [], correlations: Correlation[] = []): RouterContext {
  const scopedRuns = runs.map((run, index) => run.telegramSource ? run : {
    ...run,
    telegramSource: { botId: '123', chatId, userId: '123', createdAt: index },
  } as RunRecord);
  return {
    botUsername: 'test_bot',
    chatId,
    userId: '123',
    receiverId: 'recv',
    state: mockState(chatId, correlations),
    runs: scopedRuns,
    episode: (runId: string) => scopedRuns.find(r => r.id === runId && r.status === 'waiting') ? `episode-${runId}` : undefined,
  };
}

describe('Telegram message router', () => {
  describe('Command precedence', () => {
    it('recognizes /tasks as a command', () => {
      const update = mockUpdate('/tasks');
      const context = mockContext('123');
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('command');
      if (route.kind === 'command') {
        expect(route.name).toBe('tasks');
        expect(route.args).toBe('');
      }
    });

    it('recognizes /reply with task ID as a command', () => {
      const update = mockUpdate('/reply abc123 hello');
      const context = mockContext('123');
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('command');
      if (route.kind === 'command') {
        expect(route.name).toBe('reply');
        expect(route.args).toBe('abc123 hello');
      }
    });

    it('commands beat explicit Reply correlation', () => {
      const correlation: Correlation = {
        receiverId: 'recv',
        chatId: '123',
        messageId: 50,
        deliveryRevision: 1,
        bindingGeneration: randomUUID(),
        enableGeneration: randomUUID(),
        runId: 'run-1',
        type: 'task.attention_required',
        sequence: 1,
        episodeId: 'episode-run-1',
        continuation: 0,
        createdAt: Date.now(),
      };
      const update = mockUpdate('/tasks', 'private', 50);
      const context = mockContext('123', mockRuns(['run-1']), [correlation]);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('command');
      if (route.kind === 'command') {
        expect(route.name).toBe('tasks');
      }
    });

    it('commands beat implicit private-chat answer', () => {
      const runs = mockRuns(['run-1', 'run-2']);
      const update = mockUpdate('/status');
      const context = mockContext('123', runs);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('command');
    });
  });

  describe('Explicit Reply precedence', () => {
    it('routes Reply with correlation to explicit-reply', () => {
      const correlation: Correlation = {
        receiverId: 'recv',
        chatId: '123',
        messageId: 50,
        deliveryRevision: 1,
        bindingGeneration: randomUUID(),
        enableGeneration: ENABLED,
        runId: 'run-1',
        type: 'task.attention_required',
        sequence: 1,
        episodeId: 'episode-run-1',
        continuation: 0,
        createdAt: Date.now(),
      };
      const update = mockUpdate('yes', 'private', 50);
      const context = mockContext('123', mockRuns(['run-1']), [correlation]);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('explicit-reply');
      if (route.kind === 'explicit-reply') {
        expect(route.correlation).toEqual(correlation);
        expect(route.text).toBe('yes');
      }
    });

    it('explicit Reply beats implicit private-chat answer', () => {
      const correlation: Correlation = {
        receiverId: 'recv',
        chatId: '123',
        messageId: 50,
        deliveryRevision: 1,
        bindingGeneration: randomUUID(),
        enableGeneration: ENABLED,
        runId: 'run-1',
        type: 'task.attention_required',
        sequence: 1,
        episodeId: 'episode-run-1',
        continuation: 0,
        createdAt: Date.now(),
      };
      const runs = mockRuns(['run-1', 'run-2']);
      const update = mockUpdate('yes', 'private', 50);
      const context = mockContext('123', runs, [correlation]);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('explicit-reply');
    });

    it('routes a Reply only through a correlation of the current enable generation', () => {
      const context = mockContext('123', mockRuns(['run-1']));
      const current = context.state.receivers[0]!.generation;
      const row = (enableGeneration: string): Correlation => ({ receiverId: 'recv', chatId: '123', messageId: 50, deliveryRevision: 1,
        bindingGeneration: randomUUID(), enableGeneration, runId: 'run-1', type: 'source-final:source', sequence: 2, episodeId: 'episode-run-1',
        continuation: 0, createdAt: Date.now() });
      context.state.correlations = [row(randomUUID())];
      expect(classifyTelegramMessage(mockUpdate('more please', 'private', 50), context).kind).toBe('unmatched-reply');
      context.state.correlations = [row(current)];
      expect(classifyTelegramMessage(mockUpdate('more please', 'private', 50), context).kind).toBe('explicit-reply');
    });

    it('does not let an unmatched Reply fall through to the private task context', () => {
      const route = classifyTelegramMessage(mockUpdate('follow-up', 'private', 999), mockContext('123', mockRuns(['run-1'])));
      expect(route).toMatchObject({ kind: 'unmatched-reply', text: 'follow-up' });
    });
  });

  describe('Implicit private-chat answer', () => {
    it('routes private text to latest waiting task', () => {
      const runs = mockRuns(['run-1', 'run-2']);
      const update = mockUpdate('yes');
      const context = mockContext('123', runs);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('implicit-reply');
      if (route.kind === 'implicit-reply') {
        expect(route.runId).toBe('run-2'); // latest
        expect(route.text).toBe('yes');
      }
    });

    it('prefers the latest waiting task context for implicit reply', () => {
      const runs: RunRecord[] = [
        { id: 'run-1', status: 'done', archived: false, title: 'Done', steps: [] } as unknown as RunRecord,
        { id: 'run-2', status: 'waiting', archived: false, title: 'Waiting', steps: [] } as unknown as RunRecord,
      ];
      const update = mockUpdate('yes');
      const context = mockContext('123', runs);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('implicit-reply');
      if (route.kind === 'implicit-reply') {
        expect(route.runId).toBe('run-2');
      }
    });

    it('excludes archived tasks from implicit reply', () => {
      const runs: RunRecord[] = [
        { id: 'run-1', status: 'waiting', archived: true, title: 'Archived', steps: [] } as unknown as RunRecord,
        { id: 'run-2', status: 'waiting', archived: false, title: 'Active', steps: [] } as unknown as RunRecord,
      ];
      const update = mockUpdate('yes');
      const context = mockContext('123', runs);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('implicit-reply');
      if (route.kind === 'implicit-reply') {
        expect(route.runId).toBe('run-2');
      }
    });

    it('does not answer a waiting task belonging to another private chat', () => {
      const runs = [{ ...mockRuns(['run-1'])[0]!, telegramSource: { botId: '123', chatId: '999', userId: '123' } } as RunRecord];
      const update = mockUpdate('yes');
      const route = classifyTelegramMessage(update, mockContext('123', runs));
      expect(route.kind).toBe('unhandled');
    });

    it('uses a delivered question correlation for a cockpit-created task in this chat', () => {
      const correlation = { receiverId: 'recv', chatId: '123', messageId: 50, deliveryRevision: 1,
        bindingGeneration: randomUUID(), enableGeneration: randomUUID(), runId: 'run-1',
        type: 'task.attention_required' as const, sequence: 1, episodeId: 'episode-run-1', continuation: 0, createdAt: 20 };
      const route = classifyTelegramMessage(mockUpdate('yes'), mockContext('123', mockRuns(['run-1']), [correlation]));
      expect(route).toMatchObject({ kind: 'implicit-reply', runId: 'run-1', text: 'yes' });
    });

    const at = (hour: number, minute: number) => Date.UTC(2026, 10, 2, hour, minute);
    const correlate = (runId: string, type: string, createdAt: number, messageId = 60) => ({ receiverId: 'recv', chatId: '123', messageId, deliveryRevision: 1,
      bindingGeneration: randomUUID(), enableGeneration: randomUUID(), runId, type, sequence: 2, episodeId: `episode-${runId}`, continuation: 0, createdAt }) as Correlation;
    it('follows the latest interaction: a Telegram task’s final outranks an older cockpit question', () => {
      // A started from Telegram at 10:00; cockpit task B asks at 10:05; A's final arrives at 10:20.
      const runs = [
        { ...mockRuns(['run-a'])[0]!, status: 'done', telegramSource: { botId: '123', chatId: '123', userId: '123', createdAt: at(10, 0) } } as RunRecord,
        { ...mockRuns(['run-b'])[0]!, telegramSource: undefined } as unknown as RunRecord,
      ];
      const context = mockContext('123', runs, [correlate('run-b', 'task.attention_required', at(10, 5), 50), correlate('run-a', 'source-final:source-a', at(10, 20))]);
      context.runs = runs;
      expect(classifyTelegramMessage(mockUpdate('follow-up'), context)).toMatchObject({ kind: 'implicit-reply', runId: 'run-a' });
    });
    it('a later question of the cockpit task still wins over an older final', () => {
      const runs = [
        { ...mockRuns(['run-a'])[0]!, status: 'done', telegramSource: { botId: '123', chatId: '123', userId: '123', createdAt: at(10, 0) } } as RunRecord,
        { ...mockRuns(['run-b'])[0]!, telegramSource: undefined } as unknown as RunRecord,
      ];
      const context = mockContext('123', runs, [correlate('run-a', 'source-final:source-a', at(10, 20)), correlate('run-b', 'task.attention_required', at(10, 25), 50)]);
      context.runs = runs;
      expect(classifyTelegramMessage(mockUpdate('yes'), context)).toMatchObject({ kind: 'implicit-reply', runId: 'run-b' });
    });
    it('an explicitly addressed task becomes the context', () => {
      const runs = [
        { ...mockRuns(['run-a'])[0]!, status: 'done', telegramSource: { botId: '123', chatId: '123', userId: '123', createdAt: at(10, 0) } } as RunRecord,
        { ...mockRuns(['run-c'])[0]!, status: 'running', telegramSource: undefined } as unknown as RunRecord,
      ];
      const context = mockContext('123', runs, [correlate('run-a', 'source-final:source-a', at(10, 20))]);
      context.runs = runs;
      context.state = { ...context.state, contexts: [{ receiverId: 'recv', chatId: '123', userId: '123', runId: 'run-c', at: at(10, 30) }] };
      expect(classifyTelegramMessage(mockUpdate('and also'), context)).toMatchObject({ kind: 'implicit-reply', runId: 'run-c' });
      // Another person's context in the same receiver is not this person's.
      context.state = { ...context.state, contexts: [{ receiverId: 'recv', chatId: '123', userId: '999', runId: 'run-c', at: at(10, 30) }] };
      expect(classifyTelegramMessage(mockUpdate('and also'), context)).toMatchObject({ kind: 'implicit-reply', runId: 'run-a' });
    });
    it('ignores a final notice of a task this person did not start', () => {
      const runs = [
        { ...mockRuns(['run-a'])[0]!, status: 'done', telegramSource: { botId: '123', chatId: '123', userId: '123', createdAt: at(10, 0) } } as RunRecord,
        { ...mockRuns(['run-b'])[0]!, status: 'done', telegramSource: undefined } as unknown as RunRecord,
      ];
      const context = mockContext('123', runs, [correlate('run-b', 'task.finished', at(10, 20))]);
      context.runs = runs;
      expect(classifyTelegramMessage(mockUpdate('follow-up'), context)).toMatchObject({ kind: 'implicit-reply', runId: 'run-a' });
    });
  });

  describe('Group isolation', () => {
    it('groups never get implicit answers', () => {
      const runs = mockRuns(['run-1', 'run-2']);
      const update = mockUpdate('yes', 'group');
      const context = mockContext('-456', runs);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('unhandled');
    });

    it('group commands still work', () => {
      const update = mockUpdate('/tasks@test_bot', 'group');
      const context = mockContext('-456');
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('command');
    });

    it('group Reply with correlation still works', () => {
      const correlation: Correlation = {
        receiverId: 'recv',
        chatId: '-456',
        messageId: 50,
        deliveryRevision: 1,
        bindingGeneration: randomUUID(),
        enableGeneration: ENABLED,
        runId: 'run-1',
        type: 'task.attention_required',
        sequence: 1,
        episodeId: 'episode-run-1',
        continuation: 0,
        createdAt: Date.now(),
      };
      const update = mockUpdate('yes', 'group', 50);
      const context = mockContext('-456', mockRuns(['run-1']), [correlation]);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('explicit-reply');
    });
  });

  describe('No-pending fallback', () => {
    it('private text without pending episodes is unhandled', () => {
      const update = mockUpdate('hello');
      const context = mockContext('123', []);
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('unhandled');
    });

    it('keeps the latest Telegram task as private-chat context after it finishes', () => {
      const runs: RunRecord[] = [
        { id: 'run-1', status: 'done', archived: false, title: 'Done', steps: [],
          telegramSource: { botId: '123', chatId: '123', userId: '123', createdAt: 20 } } as unknown as RunRecord,
      ];
      const update = mockUpdate('hello');
      const context = mockContext('123', runs);
      const route = classifyTelegramMessage(update, context);

      expect(route).toMatchObject({ kind: 'implicit-reply', runId: 'run-1', text: 'hello' });
    });

    it('does not use an unrelated finished task as private-chat context', () => {
      const runs: RunRecord[] = [
        { id: 'run-1', status: 'done', archived: false, title: 'Done', steps: [] } as unknown as RunRecord,
      ];
      const update = mockUpdate('hello');
      const route = classifyTelegramMessage(update, mockContext('123', [{ ...runs[0]!, telegramSource: { botId: '123', chatId: '999', userId: '123' } } as RunRecord]));

      expect(route.kind).toBe('unhandled');
    });
  });

  describe('Unknown commands', () => {
    it('unknown slash commands are unhandled', () => {
      const update = mockUpdate('/unknown');
      const context = mockContext('123');
      const route = classifyTelegramMessage(update, context);

      expect(route.kind).toBe('unhandled');
    });
  });
});
