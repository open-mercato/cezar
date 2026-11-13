import { expect, it } from 'vitest';
import { discordDiscoveryCommand } from './index';
it('makes explicit private and guild setup commands without pretending Discord consumes a deep link', () => {
 const link = 'https://discord.com/users/123#cezar-start=one_time';
 expect(discordDiscoveryCommand(link)).toBe('/start one_time');
 expect(discordDiscoveryCommand(link, true)).toBe('<@123> /start one_time');
 expect(discordDiscoveryCommand('https://evil.test/users/123#cezar-start=one_time')).toBeUndefined();
 expect(discordDiscoveryCommand('https://discord.com/users/123#cezar-start=bad%20code')).toBeUndefined();
});
