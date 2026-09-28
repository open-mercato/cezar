import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: exec }));

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-18T00:00:00Z')); exec.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function tick() { await vi.advanceTimersByTimeAsync(0); }
function answer(text: string | null) {
  exec.mockImplementation((_cmd, _args, _opts, cb) => cb(text === null ? new Error('ps unavailable') : null, text));
}
describe('timestamped process telemetry', () => {
  it('records sampling time, not time a cached sample is requested', async () => {
    const usage = await import('./process-usage.ts');
    expect(usage).toHaveProperty('currentTimedUsage');
    answer('100 1 2048 125\n'); usage.registerRunProcess('a', 100); await tick();
    expect(usage.currentTimedUsage('a')).toEqual({ sampledAt: '2026-09-18T00:00:00.000Z', cpuPct: 125, rssBytes: 2097152, procCount: 1 });
    answer(null); await vi.advanceTimersByTimeAsync(12_000);
    expect(usage.currentTimedUsage('a')?.sampledAt).toBe('2026-09-18T00:00:00.000Z');
    usage.unregisterRunProcess('a'); expect(usage.currentTimedUsage('a')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('drops the timed sample when a process exits and does not retain it across sessions', async () => {
    const usage = await import('./process-usage.ts');
    expect(usage).toHaveProperty('currentTimedUsage');
    answer('100 1 2048 1\n'); usage.registerRunProcess('a', 100); await tick();
    answer('200 1 1000 1\n'); await vi.advanceTimersByTimeAsync(2000);
    expect(usage.currentTimedUsage('a')).toBeUndefined();
    usage.registerRunProcess('a', 200);
    expect(usage.currentTimedUsage('a')).toBeUndefined();
    usage.unregisterRunProcess('a');
  });
  it('reports Windows CPU as unmeasured while preserving legacy numeric usage', async () => {
    const usage = await import('./process-usage.ts');
    expect(usage).toHaveProperty('currentTimedUsage');
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    answer('100 1 2048 0\n'); usage.registerRunProcess('a', 100); await tick();
    expect(usage.currentTimedUsage('a')?.cpuPct).toBeNull();
    expect(usage.currentUsage('a')?.cpuPct).toBe(0);
    usage.unregisterRunProcess('a');
  });
});
