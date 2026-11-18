import { describe, expect, it } from 'vitest';
import { channelIdentity, parseChat } from './identity.ts';
import { discordPresentation } from './presentation.ts';
describe('Discord identity and presentation', () => {
 it('classifies identities and refuses raw or conflicting metadata', () => {
  expect(parseChat('discord:dm:10').kind).toBe('private'); expect(parseChat('discord:guild:20:30').kind).toBe('group');
  expect(() => parseChat('10')).toThrow(); expect(() => channelIdentity({ id: '10', type: 3 })).toThrow();
 });
 it('renders copyable addressed group commands while suppressing other mentions', () => {
  const command = discordPresentation.command('status', '1');
  expect(command).toBe('<@1> /status');
  expect(discordPresentation.formatText(`${command} @everyone`, 2000, '1')).toBe('<@1> /status @\u200beveryone');
 });
});
