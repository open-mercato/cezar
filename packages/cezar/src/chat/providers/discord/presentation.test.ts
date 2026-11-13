import { describe, expect, it } from 'vitest';
import { renderChatNotification } from '../../../webhooks/renderer.ts';
import { renderDiscordMessage } from '../../../webhooks/discord.ts';
import { discordPresentation } from './presentation.ts';

const pullRequest = 'https://github.com/acme/repo/pull/2';
const issue = 'https://github.com/acme/repo/issues/3';
const cockpit = 'http://cockpit.localhost:3000/p/project/tasks/task';
const task = { id: 'abcdefgh-task', title: 'Review change', status: 'review' };
function event(mode: 'local' | 'hosted' = 'local') {
 return JSON.stringify({ id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1,
  occurredAt: '2026-11-04T00:00:00Z', sequence: 1, source: { instanceId: 'instance', projectId: 'project', mode },
  type: 'task.review_ready', task: { ...task, previousStatus: 'running' },
  data: { episodeId: 'ep', since: '2026-11-04T00:00:00Z' }, links: { pullRequest, issue, cockpit } });
}
describe('Discord task destinations', () => {
 it('keeps the legacy review destination after upgrading to generic bot notifications', () => {
  expect(JSON.parse(renderDiscordMessage(event())).embeds[0].url).toBe(pullRequest);
  const text = renderChatNotification(event(), discordPresentation, 'discord:guild:20:30', 'Ops', true);
  expect(text).toContain(pullRequest);
  expect(text).toContain(issue);
  expect(text).not.toContain(cockpit);
 });
 it.each(['local', 'hosted'] as const)('forwards notification links with %s privacy', mode => {
  const text = renderChatNotification(event(mode), discordPresentation, 'discord:dm:10', 'Ops', false);
  expect(text).toContain(pullRequest);
  expect(text).toContain(issue);
  if (mode === 'local') expect(text).not.toContain(cockpit);
  else expect(text).toContain(cockpit);
 });
 it('preserves IPv6 URL authorities', () => {
  const url = 'https://[2001:db8::1]/task';
  const text = discordPresentation.taskReply({ ...task, links: { cockpit: url } });
  expect(text).toContain(`<${url}>`);
 });
 it('suppresses local cockpit destinations even when no public destination exists', () => {
  const body = JSON.parse(event());
  body.links = { cockpit };
  expect(renderChatNotification(JSON.stringify(body), discordPresentation, 'discord:dm:10', 'Ops', false)).not.toContain(cockpit);
 });
 it('preserves all supplied direct reply destinations', () => {
  const text = discordPresentation.taskReply({ ...task, links: { pullRequest, issue, cockpit: 'https://cockpit.example/task' } });
  for (const url of [pullRequest, issue, 'https://cockpit.example/task']) expect(text).toContain(url);
 });
 it('budgets escaped long content and complete links together', () => {
  const longLink = 'https://example.com/' + 'a'.repeat(900);
  const text = discordPresentation.taskReply({ ...task, answer: '*😀@everyone'.repeat(1000), links: { pullRequest: longLink, issue } });
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(text).toContain(longLink);
  expect(text).toContain(issue);
  expect(text).toContain('The full reply is in the cockpit.');
  expect(text).not.toContain('@everyone');
 });
 it('omits oversized links whole while retaining smaller destinations', () => {
  const text = discordPresentation.taskReply({ ...task, links: { pullRequest: 'https://example.com/' + 'x'.repeat(3000), issue } });
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(text).not.toContain('https://example.com/');
  expect(text).toContain(issue);
  expect(text).toContain('Task ready for review');
 });
 it('escapes text and URL delimiters without allowing mentions or injected lines', () => {
  const text = discordPresentation.taskReply({ ...task, title: '*title* <@123> @everyone', links: { issue: 'https://example.com/a_(b)?q=@everyone' } });
  expect(text).toContain('\\*title\\*');
  expect(text).not.toContain('<@123>');
  expect(text).not.toContain('@everyone');
  expect(text).toContain('https://example.com/a%5F%28b%29?q=%40everyone');
 });
 it.each(['javascript:alert(1)', 'file:///tmp/private', 'https://user:pass@example.com/', 'https://example.com/\n@everyone', 'not a url'])('rejects unsafe link %s', url => {
  const text = discordPresentation.taskReply({ ...task, links: { pullRequest: url, issue } });
  expect(text).not.toContain(url);
  expect(text).toContain(issue);
 });
});
