import { webhookEventSchema } from '@open-mercato/cezar-contract';

const labels = {
  'task.attention_required': 'Needs your input', 'task.review_ready': 'Ready for review',
  'task.finished': 'Task finished', 'task.failed': 'Task failed',
  'task.cancelled': 'Task cancelled', 'webhook.test': 'Test message',
};
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function clip(text: string, limit = 2900): string {
  if (text.length <= limit) return text;
  // Avoid splitting UTF-16 pairs or Slack's escaped entities.
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '').replace(/&[^;]*$/, '') + '…';
}
function section(text: string) {
  return { type: 'section' as const, text: { type: 'mrkdwn' as const, text: clip(text), verbatim: true } };
}

/** Only reads the filtered event: never loads task state or enriches private fields. */
export function renderSlackMessage(eventJson: string, ctx: { receiverName?: string } = {}): string {
  const event = webhookEventSchema.parse(JSON.parse(eventJson));
  const label = labels[event.type];
  if (event.type === 'webhook.test') {
    const text = clip(`${label} · cezar is connected to this channel${ctx.receiverName ? ` · ${escape(ctx.receiverName)}` : ''}`);
    return JSON.stringify({ text, blocks: [section(text)], link_names: false, unfurl_links: false, unfurl_media: false });
  }
  const title = escape(event.task.title || event.task.id.slice(0, 8));
  const text = clip(`${label} · ${title} · ${escape(event.source.projectId)}`);
  const blocks: unknown[] = [section(`*${label}*\n${title}\n${escape(event.task.previousStatus)} → ${escape(event.task.status)}`),
    { type: 'context', elements: [{ type: 'mrkdwn', verbatim: true,
      text: clip(`${escape(event.source.projectId)} · ${escape(event.task.id)} · ${escape(event.occurredAt)}`) }] }];
  if (event.type === 'task.attention_required' && event.data.questions?.length) {
    let questions = '';
    for (const [index, question] of event.data.questions.entries()) {
      const line = `${index + 1}. ${escape(question.question)}${(question.options ?? []).map(option =>
        `\n• ${escape(option.label)}${option.description ? ` — ${escape(option.description)}` : ''}`).join('')}`;
      if (questions && questions.length + line.length + 1 > 2900) break;
      questions += `${questions ? '\n' : ''}${clip(line)}`;
    }
    blocks.push(section(questions));
  }
  if (event.type === 'task.failed' && event.data.message) blocks.push(section(escape(event.data.message)));
  const links = Object.entries(event.links ?? {}).filter(([kind]) => kind !== 'cockpit' || event.source.mode === 'hosted')
    .map(([kind, url]) => {
      // Delimiters in a URL must not manufacture another Slack link or mention.
      const safeUrl = escape(url.replace(/[<>|\s]/g, character => encodeURIComponent(character)));
      return `<${safeUrl}|${kind === 'pullRequest' ? 'Pull request' : kind === 'issue' ? 'Issue' : 'Open in cezar'}>`;
    });
  if (links.length) blocks.push(section(links.join(' · ')));
  const options = { text, link_names: false, unfurl_links: false, unfurl_media: false };
  const body = JSON.stringify({ ...options, blocks });
  return Buffer.byteLength(body) <= 40_000 ? body : JSON.stringify(options);
}
