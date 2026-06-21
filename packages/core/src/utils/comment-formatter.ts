import type { StoredComment } from '../store/store.model.js';

interface FormatOptions {
  maxComments?: number;
  maxCharsPerComment?: number;
  maxTotalChars?: number;
}

export function formatCommentsForPrompt(
  comments: StoredComment[],
  options: FormatOptions = {},
): string {
  if (comments.length === 0) return '';

  const maxComments = options.maxComments ?? 10;
  const maxCharsPerComment = options.maxCharsPerComment ?? 500;
  const maxTotalChars = options.maxTotalChars ?? 3000;

  // Take most recent comments
  const recent = comments.slice(-maxComments);

  const lines: string[] = ['Comments (most recent):'];
  let totalChars = lines[0].length;

  for (const c of recent) {
    const date = c.createdAt.slice(0, 10);
    const body =
      c.body.length > maxCharsPerComment ? c.body.slice(0, maxCharsPerComment) + '...' : c.body;
    // Collapse multiline comment bodies to single line for compactness
    const oneLine = body.replace(/\n+/g, ' ').trim();
    const line = `@${c.author} (${date}): ${oneLine}`;

    if (totalChars + line.length + 1 > maxTotalChars) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  return lines.join('\n');
}
