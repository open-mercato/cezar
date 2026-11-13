import { expect, it } from 'vitest';
import { chatAccessGrantedText, chatHelp } from '../../conversation.ts';
import { slackDiscoveryCommand, slackPresentation } from './presentation.ts';


const bot = 'TTEAM:UREALBOT';
it('renders actionable picker instructions in group help and private access-granted notices', () => {
 const help = slackPresentation.formatText(chatHelp(slackPresentation, bot), 4000, bot);
 const access = slackPresentation.formatText(chatAccessGrantedText(slackPresentation, 'group:TTEAM:UREALBOT:CCHAN', bot), 4000, bot);
 for (const text of [help, access]) {
  expect(text).toContain('select it from Slack’s @\u200b picker');
  expect(text).toContain('followed by cezar tasks');
  expect(text).not.toContain('<@UREALBOT>');
 }
 expect(help).toContain('followed by cezar status &lt;task&gt;');
 expect(help).not.toContain('cezar task ');
 const displayed = [...help.matchAll(/followed by (cezar [a-z]+)/g)].map(match => match[1]!);
 expect(displayed).toEqual(['cezar tasks', 'cezar status', 'cezar reply', 'cezar cancel', 'cezar continue']);
});

it('keeps private instructions directly usable', () => {
 expect(slackPresentation.command('tasks')).toBe('cezar tasks');
 expect(chatAccessGrantedText(slackPresentation, 'private:TTEAM:UREALBOT:DDM', bot)).toBe('Access granted. Try cezar tasks to see this project’s tasks.');
});

it('neutralizes untrusted mentions even when they name the installed bot', () => {
 const attack = '<@UREALBOT> <!channel> @everyone &';
 expect(slackPresentation.formatText(attack, 4000, bot)).toBe('&lt;@\u200bUREALBOT&gt; &lt;!channel&gt; @\u200beveryone &amp;');
 const task = slackPresentation.taskReply({ id: 'id', title: attack, status: 'waiting', excerpt: attack, questions: [{ question: attack }] });
 expect(task).not.toContain('<@');
 expect(task).not.toContain('<!channel>');
 expect(task).not.toContain('@everyone');
});

it('composes discovery as a copyable command', () => {
 expect(slackDiscoveryCommand('https://app.slack.com/client/TTEAM/UREALBOT?cezar_start=CODE')).toBe('cezar start CODE');
});
