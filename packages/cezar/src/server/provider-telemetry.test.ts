import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../telemetry.ts', () => ({
  reportError: vi.fn(),
  telemetryEnabled: () => true,
  track: vi.fn(),
}));

import type { InconclusiveProbe } from '../core/provider-auth.ts';
import { reportError } from '../telemetry.ts';
import { reportInconclusiveProbe, watchLogin } from './provider-telemetry.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(reportError).mockClear();
});

describe('reportInconclusiveProbe', () => {
  const probe = (reason: InconclusiveProbe['reason']): InconclusiveProbe => ({
    provider: 'cursor', reason, profile: 'default', binSource: 'path', binExt: 'none', errorCode: null,
    exitCode: null, stdoutBytes: 0, stdoutJson: false, stderrBytes: 0, cliVersion: async () => '1.2.3',
  });

  // Telemetry 1ba77383, ff609bf9: a hang that outlived the 30s re-ask is nothing a parser fix reaches.
  it('reports an unreadable answer, but not a timeout', async () => {
    await reportInconclusiveProbe(probe('timeout'));
    expect(reportError).not.toHaveBeenCalled();
    await reportInconclusiveProbe(probe('unrecognized_output'));
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ProviderAuthProbeInconclusive' }),
      expect.objectContaining({ 'provider.id': 'cursor', 'provider.cli_version': '1.2.3' }),
      expect.objectContaining({ fingerprint: 'provider-auth:cursor:unrecognized_output' }),
    );
  });
});

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
