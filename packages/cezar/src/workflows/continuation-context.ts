import type { RunEvent, RunRecord } from '../runs/store.ts';

/** Keep a backend hand-off useful without turning an old, very long thread into an unbounded
 * opening prompt. The original task and current run state live outside this allowance. */
const CONVERSATION_CONTEXT_CHARS = 60_000;

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/^CEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/gm, '')
    .replace(/\s*CEZ:(?:DONE|MONITORING)\s*$/g, '')
    .replace(/\s*CEZ:ASK[ \t]+\{[\s\S]*\}\s*$/g, '')
    .trim();
  return text || undefined;
}

/**
 * Reconstruct the portable part of a task when a continuation switches runner/account and the
 * provider-owned session id therefore cannot be resumed. Events are already secret-redacted by
 * RunStore; only conversation messages are copied, never tool inputs/results or reasoning.
 */
export function freshContinuationContext(run: RunRecord, events: readonly RunEvent[]): string {
  const v2Messages = events.flatMap((event) => {
    if (event.type !== 'item.completed' || typeof event.item !== 'object' || event.item === null) return [];
    const item = event.item as { kind?: unknown; role?: unknown; text?: unknown };
    // `user-message` is Cezar's authoritative user transcript. Some normalized protocols also
    // echo user messages as items; accepting both would duplicate the instruction at hand-off.
    if (item.kind !== 'message' || item.role === 'user') return [];
    const text = cleanText(item.text);
    if (!text) return [];
    return [{ seq: event.seq, role: 'Assistant', text }];
  });
  // Modern runs persist both v1 and normalized v2 assistant output. Prefer v2 whenever it exists
  // so the new provider does not receive every answer twice; old runs fall back to v1 `text`.
  const assistant = v2Messages.length > 0
    ? v2Messages
    : events.flatMap((event) => {
        if (event.type !== 'text') return [];
        const text = cleanText(event.text);
        return text ? [{ seq: event.seq, role: 'Assistant', text }] : [];
      });
  const user = events.flatMap((event) => {
    if (event.type !== 'user-message') return [];
    const text = cleanText(event.text);
    return text ? [{ seq: event.seq, role: 'User', text }] : [];
  });
  const messages = [...user, ...assistant]
    .sort((a, b) => a.seq - b.seq)
    .map(({ role, text }) => `${role}:\n${text}`);

  let conversation = messages.join('\n\n');
  let truncated = false;
  if (conversation.length > CONVERSATION_CONTEXT_CHARS) {
    conversation = conversation.slice(-CONVERSATION_CONTEXT_CHARS);
    const firstBoundary = conversation.indexOf('\n\n');
    if (firstBoundary >= 0) conversation = conversation.slice(firstBoundary + 2);
    truncated = true;
  }

  const steps = run.steps.map((step) =>
    `- ${step.id} (${step.kind}): ${step.status}${step.error ? ` — ${step.error}` : ''}`,
  );
  return [
    'You are continuing an existing Cezar task in a fresh provider session. The previous provider session cannot be resumed. Use this persisted Cezar state and conversation as the hand-off; inspect the existing worktree before changing anything.',
    '',
    '## Original task',
    run.task,
    '',
    '## Cezar task state before this continuation',
    `Status: ${run.status}`,
    ...(run.error ? [`Error: ${run.error}`] : []),
    ...(run.branch ? [`Branch: ${run.branch}`] : []),
    ...(run.worktreePath ? [`Worktree: ${run.worktreePath}`] : []),
    ...(steps.length ? ['Steps:', ...steps] : []),
    '',
    `## Conversation history${truncated ? ' (oldest messages truncated)' : ''}`,
    conversation || '(No persisted conversation messages.)',
  ].join('\n');
}
