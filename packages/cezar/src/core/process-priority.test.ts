import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osMock = vi.hoisted(() => ({ setPriority: vi.fn() }));
const fsMock = vi.hoisted(() => ({ readdirSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), ...fsMock }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), ...osMock }));
vi.mock('node:child_process', () => ({ execFile: (_c: string, _a: string[], _o: object, cb: (e: Error) => void) => cb(new Error('no ps')) }));

beforeEach(() => {
  vi.resetModules();
  osMock.setPriority.mockReset();
  fsMock.readdirSync.mockReset();
});
afterEach(async () => {
  (await import('./process-usage.ts')).unregisterRunProcess('r');
});

describe('agent CPU priority (spec 2026-10-21-host-resource-limits)', () => {
  it('leaves the process alone by default', async () => {
    const usage = await import('./process-usage.ts');
    usage.registerRunProcess('r', 123);
    expect(osMock.setPriority).not.toHaveBeenCalled();
  });

  it('maps low and idle to below-normal and lowest, on the agent root pid', async () => {
    const { constants } = await import('node:os');
    const usage = await import('./process-usage.ts');
    usage.registerRunProcess('r', 123, 'low');
    expect(osMock.setPriority).toHaveBeenLastCalledWith(123, constants.priority.PRIORITY_BELOW_NORMAL);
    usage.registerRunProcess('r', 124, 'idle');
    expect(osMock.setPriority).toHaveBeenLastCalledWith(124, constants.priority.PRIORITY_LOW);
  });

  it('on Linux also renices every existing thread', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      fsMock.readdirSync.mockReturnValue(['123', '130', '131']);
      const { constants } = await import('node:os');
      const usage = await import('./process-usage.ts');
      usage.registerRunProcess('r', 123, 'low');
      const below = constants.priority.PRIORITY_BELOW_NORMAL;
      expect(osMock.setPriority.mock.calls.map((c) => c[0])).toEqual([123, 123, 130, 131]);
      expect(osMock.setPriority).toHaveBeenLastCalledWith(131, below);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('never throws when the OS refuses (EPERM, dead pid)', async () => {
    osMock.setPriority.mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const usage = await import('./process-usage.ts');
    expect(() => usage.registerRunProcess('r', 123, 'low')).not.toThrow();
    expect(usage.currentUsage('r')).toBeUndefined();
  });
});
