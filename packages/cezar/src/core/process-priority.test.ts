import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osMock = vi.hoisted(() => ({ setPriority: vi.fn() }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), ...osMock }));
vi.mock('node:child_process', () => ({ execFile: (_c: string, _a: string[], _o: object, cb: (e: Error) => void) => cb(new Error('no ps')) }));

beforeEach(() => {
  vi.resetModules();
  osMock.setPriority.mockReset();
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

  it('never throws when the OS refuses (EPERM, dead pid)', async () => {
    osMock.setPriority.mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const usage = await import('./process-usage.ts');
    expect(() => usage.registerRunProcess('r', 123, 'low')).not.toThrow();
    expect(usage.currentUsage('r')).toBeUndefined();
  });
});
