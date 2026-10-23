import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchLogin } from './provider-telemetry.ts';

afterEach(() => vi.useRealTimers());

describe('watchLogin', () => {
  it('re-checks on the schedule and reports the first connected answer once', async () => {
    vi.useFakeTimers();
    const answers = [false, false, true, true];
    const check = vi.fn(async () => answers.shift() ?? false);
    const onConnected = vi.fn();
    watchLogin(check, onConnected, [10, 20, 40, 80]);

    await vi.advanceTimersByTimeAsync(10);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onConnected).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('stops after the last offset, treats a failed check as not yet, and can be cancelled', async () => {
    vi.useFakeTimers();
    const failing = vi.fn(async () => { throw new Error('probe failed'); });
    const onConnected = vi.fn();
    watchLogin(failing, onConnected, [10, 20]);
    await vi.advanceTimersByTimeAsync(100);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(onConnected).not.toHaveBeenCalled();

    const check = vi.fn(async () => true);
    const cancel = watchLogin(check, onConnected, [10]);
    cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(check).not.toHaveBeenCalled();
  });
});
