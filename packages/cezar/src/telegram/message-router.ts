import type { TelegramUpdate } from './protocol.ts';
import { isTelegramCommand, parseCommand } from './protocol.ts';
import type { InboundState, Correlation } from './state.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * Router context: everything the classifier needs to make routing decisions.
 * Does not include authorization or freshness — those are conversation layer concerns.
 */
export interface RouterContext {
  /** Bot username for command parsing */
  botUsername: string;
  chatId: string;
  userId: string;
  receiverId: string;
  /** Current inbound state with correlations */
  state: InboundState;
  /** All runs to search for the current private-chat task context */
  runs: readonly RunRecord[];
  /** Episode ID lookup for each run */
  episode: (runId: string) => string | undefined;
}

/**
 * Telegram message routing variants, in precedence order:
 * 1. command: recognized slash command (handled as command, never delivered to agent)
 * 2. explicit-reply: Telegram Reply with correlation (uses message correlation)
 * 3. implicit-reply: ordinary text in approved private chat (latest task context)
 * 4. unhandled: everything else (shown help or rejected)
 */
export type TelegramMessageRoute =
  | { kind: 'command'; name: string; args: string }
  | { kind: 'explicit-reply'; correlation: Correlation; text: string }
  | { kind: 'unmatched-reply'; text: string }
  | { kind: 'implicit-reply'; runId: string; text: string }
  | { kind: 'unhandled' };

/**
 * The task an approved private chat is talking to: the newest of the person's
 * last explicit address (/task, /reply, /status, /continue or a Reply), a notice
 * this chat received about a task they started, and a question notice of any
 * task. A finished task stays the context, so a follow-up continues it.
 */
function findLatestTaskContext(context: RouterContext, runs: readonly RunRecord[]): string | undefined {
  const available = new Set(runs.filter(run => !run.archived).map(run => run.id));
  const own = new Set(runs.filter(run => available.has(run.id) && run.telegramSource?.botId === context.state.botId
    && run.telegramSource.chatId === context.chatId && run.telegramSource.userId === context.userId).map(run => run.id));
  const candidates = [
    ...context.state.correlations
      .filter(correlation => correlation.receiverId === context.receiverId && correlation.chatId === context.chatId
        && available.has(correlation.runId) && (correlation.type === 'task.attention_required' || own.has(correlation.runId)))
      .map(correlation => ({ runId: correlation.runId, at: correlation.createdAt })),
    ...runs.filter(run => own.has(run.id)).map(run => ({ runId: run.id, at: run.telegramSource!.createdAt })),
    ...(context.state.contexts ?? [])
      .filter(row => row.receiverId === context.receiverId && row.chatId === context.chatId && row.userId === context.userId && available.has(row.runId))
      .map(row => ({ runId: row.runId, at: row.at })),
  ];
  return candidates.sort((left, right) => right.at - left.at)[0]?.runId;
}

/**
 * Classify an inbound Telegram message into a routing decision.
 *
 * Precedence (from highest to lowest):
 * 1. Recognized commands (never delivered to tasks)
 * 2. Explicit Telegram Reply with correlation
 * 3. Implicit private-chat answer to the latest task context
 * 4. Unhandled (help or rejection)
 *
 * Groups never get implicit answers; they require explicit commands or Reply.
 */
export function classifyTelegramMessage(
  update: TelegramUpdate,
  context: RouterContext
): TelegramMessageRoute {
  const message = update.message;
  if (!message?.text) {
    return { kind: 'unhandled' };
  }

  const chatId = String(message.chat.id);
  const isPrivate = message.chat.type === 'private';
  const text = message.text;

  // 1. Command precedence: recognized commands are ALWAYS routed as commands
  const command = parseCommand(message, context.botUsername);
  if (command.kind === 'command' && isTelegramCommand(command.name)) {
    return { kind: 'command', name: command.name, args: command.args };
  }

  // 2. Explicit Reply precedence: Telegram Reply with valid correlation
  if (message.reply_to_message) {
    const replyToId = message.reply_to_message.message_id;
    // A receipt kept across Disable/Enable is not a reply route: it carries the older enable generation.
    const correlation = context.state.correlations.find(
      c => c.receiverId === context.receiverId && c.chatId === chatId && c.messageId === replyToId
        && context.state.receivers.find(binding => binding.receiverId === c.receiverId)?.generation === c.enableGeneration
    );
    if (correlation) {
      return { kind: 'explicit-reply', correlation, text };
    }
    return { kind: 'unmatched-reply', text };
  }

  // 3. Implicit private-chat answer: only for private chats with a task context
  if (isPrivate && command.kind === 'text') {
    const latestRunId = findLatestTaskContext(context, context.runs);
    if (latestRunId) {
      return { kind: 'implicit-reply', runId: latestRunId, text };
    }
  }

  // 4. Everything else is unhandled
  return { kind: 'unhandled' };
}
