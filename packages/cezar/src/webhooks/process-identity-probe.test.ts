import { describe, expect, it, vi } from 'vitest';
import { ownProcessIdentity, processStarts, WINDOWS_BOOT_SCRIPT } from './process-identity.ts';

// The probe is the one shell-based path whose failure mode decides whether a LIVE owner is
// declared dead (unsafe takeover), so mock the child process and pin the fail-closed direction.
const probe = vi.hoisted(() => vi.fn<(...args: unknown[]) => string>());
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], options: unknown, callback: (error: unknown, stdout: string) => void) => {
    queueMicrotask(() => {
      try { callback(null, probe(command, args, options)); }
      catch (error) { callback(error, (error as { stdout?: string }).stdout ?? ''); }
    });
  },
}));

async function withPlatform<T>(platform: string, run: () => T): Promise<Awaited<T>> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try { return await run(); } finally { Object.defineProperty(process, 'platform', original); }
}

const PS_LINE = '   4242 Ss   Thu Oct  8 09:26:18 2026\n';

function failWith(over: Record<string, unknown>): void {
  probe.mockImplementationOnce(() => { throw Object.assign(new Error('probe failed'), over); });
}

describe('probe fail-closed behaviour', async () => {
  it('never reads a killed or timed-out probe as "no such pid"', async () => {
    // execFile reports a timeout as ETIMEDOUT/SIGTERM with an empty stdout.
    failWith({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: '' });
    await expect(withPlatform('darwin', () => processStarts([4242]))).rejects.toThrow(/process identity/i);
  });

  it('discards even a partial listing from a killed probe, because a live pid may be missing', async () => {
    failWith({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: '   4243 Ss   Thu Oct  8 09:26:18 2026\n' });
    await expect(withPlatform('darwin', () => processStarts([4242]))).rejects.toThrow(/process identity/i);
  });

  it('still trusts a partial listing from a probe that exited normally', async () => {
    failWith({ code: 1, signal: null, stdout: PS_LINE });
    expect((await withPlatform('darwin', () => processStarts([4242]))).get(4242)).toBe(String(Date.UTC(2026, 9, 8, 9, 26, 18) / 1000));
  });

  it('fails closed when the probed binary is missing', async () => {
    failWith({ code: 'ENOENT', signal: null, status: null, stdout: '' });
    await expect(withPlatform('darwin', () => processStarts([4242]))).rejects.toThrow(/process identity/i);
  });

  it('drops a pid above the platform ceiling before shelling out', async () => {
    probe.mockClear();
    expect(await withPlatform('darwin', () => processStarts([100_000]))).toEqual(new Map());
    expect(probe).not.toHaveBeenCalled();
  });

  it('spawns the macOS probe by absolute path with a pinned locale and zone', async () => {
    // A GUI/launchd PATH has /usr/bin but not /usr/sbin, and an unpinned locale or zone changes
    // `lstart` in a way that reads a live owner as dead.
    probe.mockClear();
    probe.mockImplementationOnce(() => PS_LINE);
    await withPlatform('darwin', () => processStarts([4242]));
    expect(probe).toHaveBeenCalledWith('/bin/ps', ['-p', '4242', '-o', 'pid=,state=,lstart='], expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }), windowsHide: true }));
  });

  it.each([
    ['missing sentinel', `${process.pid} 638000000000000000 638900000000000000\n`],
    ['extra output', `${process.pid} 638000000000000000 638900000000000000\nnoise\ncez-own-probe-complete\n`],
    ['malformed ticks', `${process.pid} unknown 638900000000000000\ncez-own-probe-complete\n`],
    ['different pid', `${process.pid + 1} 638000000000000000 638900000000000000\ncez-own-probe-complete\n`],
  ])('fails closed when the combined Windows probe has %s', async (_name, output) => {
    probe.mockImplementationOnce(() => output);
    await expect(withPlatform('win32', () => ownProcessIdentity())).rejects.toThrow(/process identity/i);
  });

  it('asks Windows for UTC ticks in one probe, and records no PID namespace there', async () => {
    // Pins the script only: this mock cannot prove clock or zone independence.
    // A boot-token mismatch alone cannot authorize takeover (ownership-liveness.test.ts).
    probe.mockClear();
    probe.mockImplementationOnce((_command, args) => {
      const script = String((args as string[])?.[3]);
      expect(script).toContain('Get-Process -ErrorAction Stop');
      expect(script).toContain('LastBootUpTime.ToUniversalTime().Ticks');
      return `${process.pid} 638000000000000000 638900000000000000\ncez-own-probe-complete\n`;
    });
    const [own, concurrent] = await withPlatform('win32', () => Promise.all([ownProcessIdentity(), ownProcessIdentity()]));
    expect(concurrent).toBe(own);
    expect(own.boot).toBe('638900000000000000');
    expect(own.start).toBe('638000000000000000');
    expect(own.pidNamespace).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    // One full listing, never a per-pid lookup whose failure would read as "no such process".
    const probeScript = String((probe.mock.calls[0]?.[1] as string[])?.[3]);
    expect(probeScript).toContain('Get-Process -ErrorAction Stop');
    expect(probeScript).not.toContain('SilentlyContinue');
    expect(probeScript).toContain('cez-own-probe-complete');
    expect(WINDOWS_BOOT_SCRIPT).toBe('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks');
  });
});
