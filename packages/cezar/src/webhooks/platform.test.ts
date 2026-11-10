import { describe, expect, it } from 'vitest';
import { webhookPlatformSupported } from './platform.ts';

describe('webhook platform support', () => {
  it('supports exactly the platforms with an OS-verified process identity', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as NodeJS.Platform[]) {
      expect(webhookPlatformSupported(platform), platform).toBe(true);
    }
    for (const platform of ['freebsd', 'sunos', 'aix', 'openbsd', 'android'] as NodeJS.Platform[]) {
      expect(webhookPlatformSupported(platform), platform).toBe(false);
    }
  });

  it('never silently skips the feature on the host it is actually running on', () => {
    // Guards the fail-open trap: a predicate that returns false everywhere would skip every
    // webhook suite and read as green.
    if (['linux', 'darwin', 'win32'].includes(process.platform)) expect(webhookPlatformSupported()).toBe(true);
  });
});
