import type { ChatPresentation } from '../../presentation.ts';
import { readableTaskStatus } from '../../presentation.ts';
import { slackChat } from './identity.ts';
export function formatSlackText(text: string, max = 4000): string {
 let result = '';
 for (const char of text) {
  const escaped = char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '@' ? '@\u200b' : char;
  if (result.length + escaped.length > max - 1) return result + '…';
  result += escaped;
 }
 return result;
}
export const slackDiscoveryCommand = (link: string) => `cezar start ${new URL(link).searchParams.get('cezar_start') ?? ''}`;
export const slackPresentation: ChatPresentation = {
 label: 'Slack', maxText: 4000, buttonTextLimit: 75,
 formatText: formatSlackText,
 // Human guidance: pasting native <@ID> markup does not select a mention in Slack's composer.
 // Keep formatText's untrusted-text escaping intact, including mentions of this bot.
 command: (name, username) => username === undefined ? `cezar ${name}`
  : `a mention of this bot (select it from Slack’s @ picker), followed by cezar ${name}`,
 isGroup: id => slackChat(id).kind === 'group',
 discoveryLink(username, code) { const [team, user] = username.split(':'); return `https://app.slack.com/client/${encodeURIComponent(team!)}/${encodeURIComponent(user!)}?cezar_start=${encodeURIComponent(code)}`; },
 taskReply(task) {
  const lines = [`Task ${readableTaskStatus(task.status).toLowerCase()}`, task.title, `ID: ${task.id}`, task.result, task.error];
  if (['done', 'review', 'waiting'].includes(task.status)) lines.push(task.answer);
  if (task.status === 'waiting') {
   lines.push(task.excerpt);
   for (const question of task.questions ?? []) lines.push(question.question, ...(question.options ?? []).map(option => `${option.label}${option.description ? ` — ${option.description}` : ''}`));
   if (task.replyable !== false) lines.push('Reply in this message’s thread to answer the task.');
  }
  lines.push(...Object.values(task.links ?? {}));
  return formatSlackText(lines.filter(Boolean).join('\n'));
 },
 sourceOutcome(source) { return formatSlackText(source.state === 'uncertain' ? 'I cannot tell whether the task was created. Check the cockpit before trying again.' : 'The task could not be started. Check the cockpit.'); },
};
