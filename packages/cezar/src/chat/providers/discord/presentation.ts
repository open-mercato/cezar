import { readableTaskStatus, type ChatPresentation } from '../../presentation.ts';
import { parseChat } from './identity.ts';
export function discordText(text: string, max = 2000, botId?: string): string {
 const escaped = text.replace(/@/g, '@\u200b').replace(/[\\*_~`|<>\[\]]/g, '\\$&');
 const clipped = escaped.length <= max ? escaped : escaped.slice(0, Math.max(0, max - 1)).replace(/[\\\uD800-\uDBFF]$/, '') + '…';
 return botId && /^[1-9][0-9]{0,19}$/.test(botId) ? clipped.replaceAll(`\\<@\u200b${botId}\\>`, `<@${botId}>`) : clipped;
}
// Keep destinations whole and reserve at least 500 characters for the task itself.
function taskLinks(links: import('../../presentation.ts').TaskReply['links']): string {
 let tail = '';
 for (const [label, value] of [['Pull request', links?.pullRequest], ['Issue', links?.issue], ['Cockpit', links?.cockpit]]) {
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) continue;
  try {
   const url = new URL(value);
   if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
   // Autolinks avoid Markdown labels; encode delimiters and mention syntax in URLs.
   const href = url.origin + (url.pathname + url.search + url.hash).replace(/[<>()\[\]\\*_~`|@]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
   const line = `\n${label}: <${href}>`;
   if (tail.length + line.length <= 1500) tail += line;
  } catch { /* An invalid destination must not prevent the task reply. */ }
 }
 return tail;
}
export const discordPresentation: ChatPresentation = {
 label: 'Discord', maxText: 2000, buttonTextLimit: 80, formatText: discordText,
 command: (name, botId) => `${botId && /^[1-9][0-9]{0,19}$/.test(botId) ? `<@${botId}> ` : ''}/${name}`, isGroup: id => parseChat(id).kind === 'group',
 discoveryLink: (id, code) => `https://discord.com/users/${encodeURIComponent(id)}#cezar-start=${encodeURIComponent(code)}`,
 taskReply(task) {
  const heading = task.status === 'review' ? 'Task ready for review' : readableTaskStatus(task.status);
  const lines = [heading, task.title, `Task: ${task.id}`, task.result, task.error];
  if (['done', 'review', 'waiting'].includes(task.status)) lines.push(task.answer ?? task.excerpt);
  if (task.status === 'waiting') { for (const question of task.questions ?? []) lines.push(question.question, ...(question.options ?? []).map(option => option.label)); if (task.replyable !== false) lines.push('Reply to this message to answer the task.'); }
  const text = lines.filter(Boolean).join('\n');
  const links = taskLinks(task.links);
  const room = 2000 - links.length;
  const note = '\nThe full reply is in the cockpit.';
  const formatted = discordText(text, room);
  return (discordText(text, Number.MAX_SAFE_INTEGER).length > room
   ? discordText(text, room - note.length) + note : formatted) + links;
 },
 sourceOutcome: source => discordText(source.state === 'uncertain' ? 'I cannot tell whether the task was created. Check the cockpit before trying again.' : 'The task was not started. Check the cockpit before trying again.'),
};
