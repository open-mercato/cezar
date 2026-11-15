import { webhookEventSchema } from '@open-mercato/cezar-contract';

const presentation = {
  'task.attention_required': ['Needs your input', 15105570], 'task.review_ready': ['Ready for review', 3447003],
  'task.finished': ['Task finished', 3066993], 'task.failed': ['Task failed', 15158332],
  'task.cancelled': ['Task cancelled', 9807270], 'webhook.test': ['Test message', 3447003],
} as const;
function escape(text: string): string {
  return text.replace(/@/g, '@\u200b').replace(/[\\*_~`|>\[\]()]/g, '\\$&').replace(/^(\s*)([#-])/gm, '$1\\$2');
}
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '').replace(/\\$/, '') + '…';
}

/** Keep URL tokens intact: markdown escaping inside <...> breaks Discord's no-unfurl syntax. */
function contentText(text: string, limit = 2000): string {
  const parts: string[] = [];
  let cursor = 0, length = 0;
  const add = (part: string, atomic = false): boolean => {
    const available = limit - length;
    if (available <= 0) return part.length === 0;
    if (part.length > available) {
      if (atomic) { if (available > 0) parts.push('…'); }
      else parts.push(clip(part, available));
      return false;
    }
    parts.push(part); length += part.length; return true;
  };
  const urls = /<?(https?:\/\/[^\s<>\\]+)>?/gi;
  for (let match; (match = urls.exec(text));) {
    if (!add(escape(text.slice(cursor, match.index)))) return parts.join('');
    let url = match[1]!; // Preserve URL syntax; allowed_mentions disables mention parsing.
    const wrapped = match[0].startsWith('<') && match[0].endsWith('>');
    if (!wrapped) {
      // Balanced delimiters belong to the URL (including IPv6 hosts); an unmatched
      // closer belongs to surrounding prose or Markdown, e.g. [label](url).
      const closers: string[] = [];
      for (let i = 0; i < url.length; i++) {
        const char = url[i]!;
        if (char === '(' || char === '[') closers.push(char === '(' ? ')' : ']');
        else if (char === ')' || char === ']') {
          if (closers.pop() !== char) { url = url.slice(0, i); break; }
        }
      }
    }
    if (!add(`<${url}>`, true)) return parts.join('');
    cursor = match.index + (wrapped ? match[0].length : (match[0].startsWith('<') ? 1 : 0) + url.length);
    urls.lastIndex = cursor; // Scan again after a closer, including adjacent Markdown links.
  }
  add(escape(text.slice(cursor)));
  return parts.join('');
}

/** Renders only the event's existing privacy-filtered fields; mention parsing stays disabled. */
export function renderDiscordMessage(eventJson: string, ctx: { receiverName?: string } = {}): string {
  const event = webhookEventSchema.parse(JSON.parse(eventJson));
  const [label, color] = presentation[event.type];
  const allowed_mentions = { parse: [] };
  if (event.type === 'webhook.test') {
    return JSON.stringify({ content: contentText(`${label} · cezar is connected to this channel${ctx.receiverName ? ` · ${ctx.receiverName}` : ''}`), allowed_mentions });
  }
  const title = escape(event.task.title || event.task.id.slice(0, 8));
  const content = contentText(`${label} · ${event.task.title || event.task.id.slice(0, 8)}`);
  const fields = [
    { name: 'Project', value: clip(escape(event.source.projectId), 1024), inline: true },
    { name: 'Status', value: `${escape(event.task.previousStatus)} → ${escape(event.task.status)}`, inline: true },
    { name: 'Task', value: clip(escape(event.task.id), 1024), inline: true },
  ];
  if (event.type === 'task.failed' && event.data.message) fields.push({ name: 'Error', value: clip(escape(event.data.message), 1024), inline: false });
  const embedTitle = clip(`${label} · ${title}`, 256);
  const fixedLength = embedTitle.length + 'cezar'.length + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  const descriptionLimit = Math.min(4096, 6000 - fixedLength);
  let description = '';
  if (event.type === 'task.attention_required') {
    for (const [index, question] of (event.data.questions ?? []).entries()) {
      const line = `${index + 1}. ${escape(question.question)}${(question.options ?? []).map(option =>
        `\n• ${escape(option.label)}${option.description ? ` — ${escape(option.description)}` : ''}`).join('')}`;
      if (description && description.length + line.length + 1 > descriptionLimit) break;
      description += `${description ? '\n' : ''}${clip(line, descriptionLimit)}`;
    }
  }
  const url = event.links?.pullRequest ?? event.links?.issue ?? (event.source.mode === 'hosted' ? event.links?.cockpit : undefined);
  const embed = { title: embedTitle, color, timestamp: event.occurredAt, fields, footer: { text: 'cezar' },
    ...(description ? { description } : {}), ...(url ? { url } : {}) };
  if (fixedLength + description.length > 6000) return JSON.stringify({ content, allowed_mentions });
  return JSON.stringify({ content, allowed_mentions, embeds: [embed] });
}
