import { delimiter } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSync = vi.hoisted(() => vi.fn((p: string) => p === '/b/notify-send'));
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync }));

import { systemNotificationsAvailable } from './system-notify.ts';

describe('systemNotificationsAvailable PATH probe (#2413)', () => {
  beforeEach(() => existsSync.mockClear());

  it('scans a PATH value once, however many requests ask', () => {
    const env = { PATH: ['/x1', '/x2', '/x3'].join(delimiter) };
    for (let i = 0; i < 50; i++) expect(systemNotificationsAvailable('linux', env)).toBe(false);
    expect(existsSync).toHaveBeenCalledTimes(3);
  });

  it('re-probes and stays correct when PATH changes', () => {
    expect(systemNotificationsAvailable('linux', { PATH: ['/y1', '/y2'].join(delimiter) })).toBe(false);
    expect(systemNotificationsAvailable('linux', { PATH: ['/y1', '/b'].join(delimiter) })).toBe(true);
    expect(systemNotificationsAvailable('linux', { PATH: '/y1' })).toBe(false);
  });
});
