/**
 * Forwarding a user's chat message into a task, and the guard against an objective that holds a
 * placeholder where that content belongs (spec 2026-10-31-managers § Forwarding). Claude Code
 * refuses a matching `Bash(cez-manager:*)` command once it passes ~10k characters, so a long paste
 * has to reach the task server-side, never as a shell argument.
 */

export const FORWARD_OPEN = "--- The user's message, forwarded verbatim by the manager ---";
export const FORWARD_CLOSE = '--- End of the forwarded message ---';

/** The objective, then the message untouched between two marker lines. */
export function withForwarded(objective: string | undefined, text: string, attachments: number): string {
  const lead = objective?.trim() ?? '';
  const files = attachments > 0 ? `${text ? '\n\n' : ''}(The user's ${attachments === 1 ? 'attachment is' : `${attachments} attachments are`} attached to this message.)` : '';
  return `${lead ? `${lead}\n\n` : ''}${FORWARD_OPEN}\n${text}${files}\n${FORWARD_CLOSE}`;
}

const PLACEHOLDERS: RegExp[] = [
  /<<<[^<>\n]{0,80}>>>/,
  /\{\{\s*(?:transcript|content|text|paste|insert|notes)[^{}\n]{0,40}\}\}/i,
  // `[transcript here]`, `[paste the notes]`, `[full text omitted]` — but never a markdown link.
  /\[(?=[^\]\n]{0,80}\b(?:paste|insert|transcript|transkrypcj\w*|wklej\w*|content|text|notes|message)\b)(?=[^\]\n]{0,80}\b(?:here|below|tutaj|paste[ds]?|insert(?:ed)?|omitted|truncated|goes|wklej\w*)\b)[^\]\n]{1,80}\](?!\()/i,
  /<(?:paste|insert)\b[^<>\n]{0,60}>/i,
  /<(?:transcript|content|text)[ _-]?here>/i,
  /\((?:the |full |complete )?(?:transcript|text|content|notes)\s+(?:omitted|truncated|goes here|here)\)/i,
  /\bTODO[ _:-]*(?:insert|paste)\b/i,
  /\bPASTE(?:[ _-]?(?:HERE|BELOW|TRANSCRIPT|CONTENT|TEXT))?\b/,
];

/** The first placeholder marker in model-written text, or undefined. */
export function placeholderIn(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const pattern of PLACEHOLDERS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

export const placeholderRefusal = (marker: string): string =>
  `refused: the text holds a placeholder (${JSON.stringify(marker)}) where real content belongs, so the task would never see it. `
  + 'Forward the user\'s message with --attach-last-user-message (or --from-message <id>), pass a file with --file, or write the real text. '
  + 'If the marker is meant literally, add --allow-placeholder. Tell the user what happened in your reply.';
