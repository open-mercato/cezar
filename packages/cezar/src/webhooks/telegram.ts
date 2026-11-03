import { webhookEventSchema, type WebhookCompletionReason } from '@open-mercato/cezar-contract';

const statusLabels: Record<string, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting for your answer', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled', review: 'Ready for review', expired: 'Expired' };
/** Human status names shared by notifications and bot replies; unknown codes never leak. */
export const readableTaskStatus = (status: string): string => statusLabels[status] ?? 'Status unavailable';
/** The `Repository:` line of a finished task: what happened to the code, never the agent's answer.
 *  `completed` and `unknown` say nothing beyond the status, so they have no line. */
export const readableCompletionReason: Record<WebhookCompletionReason, string | undefined> = {
  pr_opened: 'Pull request opened', accepted: 'Changes accepted', no_changes: 'Unchanged', completed: undefined, unknown: undefined,
};
const headings: Record<string, string> = { waiting: 'Task needs your input', review: 'Task ready for review', done: 'Task completed', failed: 'Task failed', cancelled: 'Task cancelled', expired: 'Task update expired' };
// Group commands need the @bot suffix the renderer does not know, so groups get the Reply path only.
const hints = { private: 'Reply to this message to answer the task, or just type your answer here.', group: 'Reply to this message to answer the task.' } as const;
// Budgets count the escaped HTML: stricter than Telegram's visible-text limit, and what the dispatcher checks.
const LIMIT = 4096;
type Part = { text: string; tag?: 'b' | 'code'; href?: string };
type Question = { question: string; options?: Array<{ label: string; description?: string }> };
type Links = { pullRequest?: string; issue?: string; cockpit?: string };

export interface TelegramTaskReply {
  id: string; title: string; status: string; result?: string; error?: string;
  /** Already consent-filtered, redacted and bounded by agentExcerpt. */
  excerpt?: string;
  /** A finished task's final reply, redacted and bounded by agentAnswer; a trailing `…` marks it shortened. */
  answer?: string;
  questions?: Question[];
  links?: Links; privateChat?: boolean;
  /** False when a Reply cannot reach the task, so the notice must not invite one. */
  replyable?: boolean;
}

/** The one task-notice model both paths render; every text field is still raw. */
interface TaskNotice {
  status: string; id: string; title?: string; previousStatus?: string; project?: string;
  result?: string; error?: string; excerpt?: string; answer?: string; questions?: Question[];
  links?: Links; hint?: keyof typeof hints;
}

export function renderTelegramSourceOutcome(outcome: { state: string; policyReason?: string }): string {
  const text = outcome.state === 'uncertain'
    ? 'I cannot tell whether the task was created. Check the cockpit before trying again.'
    : outcome.state === 'expired'
      ? 'This Telegram task request expired before it could be completed. Check the cockpit.'
      : outcome.policyReason === 'account_unavailable'
        ? 'The saved account is unavailable. Nothing was run; check the cockpit.'
        : outcome.policyReason === 'provider_unavailable'
          ? 'The task provider is unavailable. Nothing was run; check the cockpit.'
          : outcome.policyReason === 'project_unavailable'
            ? 'The launch configuration or access changed. Nothing was started. Send /task again to review and confirm the current target.'
            : 'The task could not be started. Nothing was run; check the cockpit.';
  return formatTelegramText(text);
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…';
}
// `@` gets a zero-width space so task text cannot read as a mention or channel handle.
const neutral = (text: string) => text.replace(/@/g, '@​');
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function html(lines: Part[][]): string {
  return lines.map(line => line.map(part => {
    const text = escape(part.text);
    if (part.href) return `<a href="${escape(part.href).replace(/"/g, '&quot;')}">${text}</a>`;
    return part.tag ? `<${part.tag}>${text}</${part.tag}>` : text;
  }).join('')).join('\n');
}

/** Renders only the event's existing privacy-filtered fields. `replyHint` defaults off: only a receiver with two-way Telegram active can act on the hint. */
export function renderTelegramMessage(eventJson: string, ctx: { chatId: string; receiverName?: string; replyHint?: boolean }): string {
  if (!ctx.chatId) throw new Error('Telegram receiver has no chat ID');
  const event = webhookEventSchema.parse(JSON.parse(eventJson));
  const wire = (text: string) => JSON.stringify({ chat_id: ctx.chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  if (event.type === 'webhook.test') {
    return wire(html([[{ text: 'Test message', tag: 'b' }, { text: neutral(clip(` · cezar is connected to this chat${ctx.receiverName ? ` · ${ctx.receiverName}` : ''}`, 512)) }]]));
  }
  const waiting = event.type === 'task.attention_required';
  const { pullRequest, issue, cockpit } = event.links ?? {};
  return wire(renderNotice({ status: event.task.status, id: event.task.id, title: event.task.title, previousStatus: event.task.previousStatus, project: event.source.projectId,
    ...(event.type === 'task.failed' ? { error: event.data.message } : {}),
    // Same `Repository:` line as the runtime's final, so both finals read alike.
    ...(event.type === 'task.finished' && readableCompletionReason[event.data.resolution] ? { result: readableCompletionReason[event.data.resolution] } : {}),
    ...(waiting ? { questions: event.data.questions, excerpt: event.data.agentExcerpt } : {}),
    links: { pullRequest, issue, ...(event.source.mode === 'hosted' ? { cockpit } : {}) },
    ...(waiting && ctx.replyHint === true ? { hint: ctx.chatId.startsWith('-') ? 'group' : 'private' } : {}) }));
}

/** Same layout as webhook notices, for the runtime's replies to the requester's chat. */
export function renderTelegramTaskReply(task: TelegramTaskReply): string {
  const finished = task.status === 'done' || task.status === 'review', waiting = task.status === 'waiting';
  // A free-text question is the agent's reply itself: it replaces the opt-in excerpt.
  const replied = finished || (waiting && !task.questions?.length && !!task.answer);
  return renderNotice({ status: task.status, id: task.id, title: task.title, result: task.result, error: task.error, links: task.links,
    ...(replied ? { answer: task.answer } : {}),
    ...(waiting && !replied ? task.questions?.length ? { questions: task.questions } : { excerpt: task.excerpt } : {}),
    ...(waiting && task.replyable !== false ? { hint: task.privateChat ? 'private' : 'group' } : {}) });
}

/** Plain command replies use the same escaping and mention policy as event notifications;
 *  `/command@<botUsername>` stays intact because groups only route the addressed form. */
export function formatTelegramText(value: string, limit = 4096, botUsername?: string): string {
  let low = 0, high = Math.min(value.length, limit), result = '';
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    let candidate = escape(neutral(clip(value, length)));
    if (botUsername) candidate = candidate.replace(new RegExp(`(/[A-Za-z0-9_]+)@​(${botUsername.replace(/[^A-Za-z0-9_]/g, '')})(?![A-Za-z0-9_])`, 'gi'), '$1@$2');
    if (candidate.length <= limit) { result = candidate; low = length + 1; }
    else high = length - 1;
  }
  return result;
}

/** Largest clip of `text` whose escaped line fits `room`; the dispatcher refuses raw HTML over 4096. */
function fitLine(prefix: string, text: string, max: number, room: number): Part[] | undefined {
  let low = 1, high = Math.min(text.length, max), best: string | undefined;
  while (low <= high) {
    const length = Math.floor((low + high) / 2), candidate = `${prefix}${neutral(clip(text, length))}`;
    if (escape(candidate).length <= room) { best = candidate; low = length + 1; } else high = length - 1;
  }
  return best === undefined ? undefined : [{ text: best }];
}

/** Header, status, id, repository/error, answer, excerpt, questions, hint, link — in that order. */
function renderNotice(notice: TaskNotice): string {
  const was = notice.previousStatus ? ` (was ${readableTaskStatus(notice.previousStatus).toLowerCase()})` : '';
  const lines: Part[][] = [[{ text: headings[notice.status] ?? 'Task in progress', tag: 'b' }, { text: ` · ${neutral(clip(notice.title || notice.id.slice(0, 8), 256))}` }], [],
    ...(notice.project ? [[{ text: `Project: ${neutral(clip(notice.project, 256))}` }]] : []),
    [{ text: `Status: ${readableTaskStatus(notice.status)}${was}` }], [{ text: 'Task: ' }, { text: clip(notice.id, 128), tag: 'code' }]];
  const core = lines.length;
  const { pullRequest, issue, cockpit } = notice.links ?? {};
  const url = [pullRequest, issue, cockpit].find(Boolean);
  const link: Part[] | undefined = url && /^https?:\/\//i.test(url)
    ? [{ text: url === pullRequest ? 'Open pull request' : url === issue ? 'Open issue' : 'Open in cezar', href: url }] : undefined;
  const tail = (withHint: boolean): Part[][] => [...(withHint && notice.hint ? [[], [{ text: hints[notice.hint] }]] : []), ...(link ? [[], link] : [])];
  // Room for one more line before the tail, counting its joining newline.
  const room = () => LIMIT - html([...lines, ...tail(true)]).length - 1;
  for (const [prefix, value] of [['Repository: ', notice.result], ['Error: ', notice.error]] as const) {
    const line = value ? fitLine(prefix, value, 2048, room()) : undefined;
    if (line) lines.push(line);
  }
  if (notice.answer) {
    lines.push([]);
    const whole = notice.answer.endsWith('…') ? undefined : fitLine('Agent: ', notice.answer, notice.answer.length, room());
    if (whole && whole[0]!.text === `Agent: ${neutral(notice.answer)}`) lines.push(whole);
    else {
      // A shortened reply says where the rest is, so nobody mistakes it for the whole answer.
      const note: Part[] = [{ text: 'The full reply is in the cockpit.' }];
      const line = fitLine('Agent: ', notice.answer, notice.answer.length, room() - html([note]).length - 1);
      if (line) lines.push(line, note); else lines.pop();
    }
  }
  if (notice.excerpt) {
    lines.push([]);
    const line = room() > 64 ? fitLine('Agent: ', notice.excerpt, notice.excerpt.length, room()) : undefined;
    if (line) lines.push(line); else lines.pop();
  }
  if (notice.questions?.length) {
    lines.push([]);
    for (const [index, question] of notice.questions.entries()) {
      const text = `${index + 1}. ${question.question}${(question.options ?? []).map(option =>
        `\n• ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('')}`;
      const line = fitLine('', text, text.length, room());
      // Drop trailing questions first; clip only the first one that does not fit.
      if (line?.[0]!.text === neutral(text)) { lines.push(line); continue; }
      if (line && index === 0 && room() > 64) lines.push(line);
      break;
    }
    if (lines.at(-1)!.length === 0) lines.pop();
  }
  for (const withHint of [true, false]) {
    const rendered = html([...lines, ...tail(withHint)]);
    if (rendered.length <= LIMIT) return rendered;
  }
  // Only an oversized link gets here: keep the heading, status and id.
  const head = html(lines.slice(0, core)), linked = link ? html([...lines.slice(0, core), [], link]) : head;
  return linked.length <= LIMIT ? linked : head;
}
