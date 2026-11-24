import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  RUN_USER_MESSAGE_PREVIEW_CHARS,
  isImageAttachmentName,
  type RunUserMessage,
} from '@open-mercato/cezar-contract';

/** Splits attachment URLs into image and file counts by file NAME (#950). */
export function countAttachments(urls: readonly string[]): { images: number; files: number } {
  let images = 0;
  for (const url of urls) {
    const name = url.split('?')[0]?.split('/').pop() ?? '';
    if (isImageAttachmentName(decodeURIComponentSafe(name))) images += 1;
  }
  return { images, files: urls.length - images };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const preview = (text: string): string => text.slice(0, RUN_USER_MESSAGE_PREVIEW_CHARS);

/**
 * The run's own messages, oldest first (spec 2026-11-17-my-message-navigation): the opening task
 * as seq 0, then one entry per persisted `user-message` line. Streams the NDJSON, parsing only
 * candidate lines; a missing file or a malformed line is skipped, never an error.
 */
export async function readRunUserMessages(
  file: string,
  opening: { task: string; ts?: string; images?: readonly string[] },
): Promise<RunUserMessage[]> {
  const first = countAttachments(opening.images ?? []);
  const messages: RunUserMessage[] = [
    { seq: 0, ...(opening.ts ? { ts: opening.ts } : {}), text: preview(opening.task), ...first },
  ];
  const stream = createReadStream(file, { encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes('user-message')) continue;
      let event: { type?: unknown; seq?: unknown; ts?: unknown; text?: unknown; images?: unknown; imageCount?: unknown };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== 'user-message' || typeof event.seq !== 'number') continue;
      const urls = Array.isArray(event.images) ? event.images.filter((u): u is string => typeof u === 'string') : undefined;
      const counts = urls
        ? countAttachments(urls)
        : { images: typeof event.imageCount === 'number' ? event.imageCount : 0, files: 0 };
      messages.push({
        seq: event.seq,
        ...(typeof event.ts === 'string' ? { ts: event.ts } : {}),
        text: preview(typeof event.text === 'string' ? event.text : ''),
        ...counts,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    stream.destroy();
  }
  return messages;
}
