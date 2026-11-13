import type { InputUpdate } from './events.ts';
import { isChatCommand } from './events.ts';
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

export type ChatMessageRoute =
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
  const own = new Set(runs.filter(run => available.has(run.id) && run.chatSource?.provider === context.state.provider && run.chatSource.botId === context.state.botId
    && run.chatSource.chatId === context.chatId && run.chatSource.userId === context.userId).map(run => run.id));
  const candidates = [
    ...context.state.correlations
      .filter(correlation => correlation.receiverId === context.receiverId && correlation.chatId === context.chatId
        && available.has(correlation.runId) && (correlation.type === 'task.attention_required' || own.has(correlation.runId)))
      .map(correlation => ({ runId: correlation.runId, at: correlation.createdAt })),
    ...runs.filter(run => own.has(run.id)).map(run => ({ runId: run.id, at: run.chatSource!.createdAt })),
    ...(context.state.contexts ?? [])
      .filter(row => row.receiverId === context.receiverId && row.chatId === context.chatId && row.userId === context.userId && available.has(row.runId))
      .map(row => ({ runId: row.runId, at: row.at })),
  ];
  return candidates.sort((left, right) => right.at - left.at)[0]?.runId;
}

/**
 * Precedence: a recognized command (never delivered to a task), an explicit Reply with a
 * correlation, an implicit private-chat answer to the latest task context, then unhandled.
 * Groups never get implicit answers; they require explicit commands or Reply.
 */
export function classifyChatMessage(
  update: InputUpdate,
  context: RouterContext
): ChatMessageRoute {
  const message = update.message;
  if (!message?.text) {
    return { kind: 'unhandled' };
  }

  const chatId = String(message.chat.id);
  const isPrivate = message.chat.kind === 'private';
  const text = message.text;

  // 1. Command precedence: recognized commands are ALWAYS routed as commands
  const command = message.command;
  if (command.kind === 'command' && isChatCommand(command.name)) {
    return { kind: 'command', name: command.name, args: command.args };
  }

  // 2. Explicit Reply precedence: Telegram Reply with valid correlation
  if (message.replyTo) {
    const replyToId = message.replyTo;
    // A receipt kept across Disable/Enable is not a reply route: it carries the older enable generation.
    const correlation = [...context.state.correlations].sort((a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence).find(
      c => c.receiverId === context.receiverId && c.chatId === chatId && (c.messageId === replyToId || (c.replyTo?.chatId === chatId && c.replyTo.messageId === replyToId))
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
