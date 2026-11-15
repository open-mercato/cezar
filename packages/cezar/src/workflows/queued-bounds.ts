import { statSync } from 'node:fs';
import { join } from 'node:path';
import { isImageAttachmentName, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BASE64, type QueuedMessage } from '@open-mercato/cezar-contract';
import type { PastedContent } from './run.ts';

// Queued prompt stack bounds (#472), shared by `POST /runs/:id/messages` and the engine's own
// redelivery of deferred messages, so neither path can grow a stack the other would refuse.
// The per-message bounds mirror the message schema; the one that actually matters is the FOLDED
// total, because 20 messages of 100 000 chars each would otherwise compose a ~2 M-character {{task}}.
export const MAX_MESSAGE_TEXT_CHARS = 100_000;
export const MAX_QUEUED_MESSAGES = 20;
export const MAX_QUEUED_ATTACHMENTS = 2 * MAX_ATTACHMENTS_PER_MESSAGE;
export const MAX_FOLDED_TASK_CHARS = 200_000;
export const QUEUED_IMAGES_TOO_LARGE = 'too many queued images — 20 MB of images across the task and its queued messages';

/** Length of the prompt a run would execute with — `task` plus its whole stack,
 *  composed exactly as `hydrateQueuedInput` composes it. Checked against the
 *  PROSPECTIVE state so the user is stopped at the write, not at dequeue where
 *  there would be no one left to tell. */
export function foldedLength(task: string, stack: Array<{ text: string }>): number {
  return [task, ...stack.map((m) => m.text)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n').length;
}

/** Base64 size of the images a queued run's OPENING turn will carry: its task images plus every
 *  stacked message's, read back from disk at dequeue and delivered together (#472). */
export function queuedImageChars(dataDir: string, runId: string, urls: readonly string[]): number {
  let bytes = 0;
  for (const url of urls) {
    const name = url.split('/').pop() ?? '';
    if (!isImageAttachmentName(name) || name.includes('..')) continue;
    try {
      bytes += statSync(join(dataDir, 'runs', `${runId}-images`, name)).size;
    } catch {
      // Gone files are dropped at dequeue too.
    }
  }
  return Math.ceil(bytes / 3) * 4;
}

/** Base64 size of the image blocks among a message's resolved attachments. */
export function imageChars(content: readonly PastedContent[]): number {
  return content.reduce((n, b) => (b.type === 'image' ? n + b.source.data.length : n), 0);
}

/** The text a message's blocks carry, joined the way a stacked message stores it. */
export function messageText(content: readonly PastedContent[]): string {
  return content
    .filter((b): b is Extract<PastedContent, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Why stacking `content` onto a queued run would be refused, or undefined when it fits.
 *  `text` defaults to the content's own text blocks. */
export function queuedStackRefusal(
  dataDir: string,
  run: { id: string; task: string; taskImages?: string[]; queuedMessages?: QueuedMessage[] },
  content: readonly PastedContent[],
  text = messageText(content),
): string | undefined {
  const stack = run.queuedMessages ?? [];
  if (stack.length >= MAX_QUEUED_MESSAGES) return `too many queued messages — ${MAX_QUEUED_MESSAGES} message limit`;
  const stackedImages = stack.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  if (stackedImages + content.filter((b) => b.type !== 'text').length > MAX_QUEUED_ATTACHMENTS) {
    return `too many queued attachments — ${MAX_QUEUED_ATTACHMENTS} attachment limit across the stack`;
  }
  const opening = [...(run.taskImages ?? []), ...stack.flatMap((m) => m.images ?? [])];
  if (queuedImageChars(dataDir, run.id, opening) + imageChars(content) > MAX_ATTACHMENTS_TOTAL_BASE64) return QUEUED_IMAGES_TOO_LARGE;
  const prospective = foldedLength(run.task, [...stack, { text }]);
  if (prospective > MAX_FOLDED_TASK_CHARS) {
    return `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`;
  }
  return undefined;
}

/** Why one Continue could not carry `content` — the `POST /runs/:id/continue` body bounds. */
export function continuePromptRefusal(text: string, content: readonly PastedContent[]): string | undefined {
  if (text.length > MAX_MESSAGE_TEXT_CHARS) return `prompt too long — ${MAX_MESSAGE_TEXT_CHARS} character limit for one turn`;
  if (content.filter((b) => b.type !== 'text').length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return `too many attachments — ${MAX_ATTACHMENTS_PER_MESSAGE} attachment limit for one turn`;
  }
  if (imageChars(content) > MAX_ATTACHMENTS_TOTAL_BASE64) return 'too many images for one turn';
  return undefined;
}
