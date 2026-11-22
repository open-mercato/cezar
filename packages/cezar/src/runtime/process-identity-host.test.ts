import { describe, expect, it } from 'vitest';
import { isProcessIdentityAlive, ownHostedProcessIdentity } from './process-identity.ts';

// #2398: a renamed host with the same stable boot ID is the same kernel; other cases stay fenced.
describe('isProcessIdentityAlive across a host rename', () => {
  it('judges by pid+start when the stable boot ID matches', async () => {
    const own = await ownHostedProcessIdentity();
    const renamed = { ...own, host: 'renamed-host.example' };
    if (own.boot.length < 36) return; // Windows boot tokens are never trusted across hosts
    expect(await isProcessIdentityAlive(renamed, own)).toBe(true);
    expect(await isProcessIdentityAlive({ ...renamed, start: '1' }, own)).toBe(false);
  });

  it('still throws for another host with a different boot ID', async () => {
    const own = await ownHostedProcessIdentity();
    const other = { ...own, host: 'renamed-host.example', boot: '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e' };
    await expect(isProcessIdentityAlive(other, own)).rejects.toThrow('Cannot verify foreign owner identity');
  });
});
