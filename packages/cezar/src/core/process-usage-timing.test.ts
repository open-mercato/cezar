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

  it('samples multiple roots from one snapshot without changing their independent totals', async () => {
    const usage = await import('./process-usage.ts');
    let mapCount = 0;
    const NativeMap = Map;
    class CountingMap<K, V> extends NativeMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        mapCount += 1;
      }
    }
    vi.stubGlobal('Map', CountingMap);
    answer('100 1 100 1\n101 100 50 2\n200 1 200 3\n201 200 25 4\n');
    usage.registerRunProcess('ancestor', 100);
    usage.registerRunProcess('descendant', 101);
    await tick();

    expect(usage.currentUsage('ancestor')).toEqual({ cpuPct: 3, rssBytes: 153600, procCount: 2 });
    expect(usage.currentUsage('descendant')).toEqual({ cpuPct: 2, rssBytes: 51200, procCount: 1 });
    expect(mapCount).toBe(2);
    expect(usage.unregisterRunProcess('ancestor')).toEqual({ peakRssBytes: 153600, peakProcCount: 2 });
    expect(usage.unregisterRunProcess('descendant')).toEqual({ peakRssBytes: 51200, peakProcCount: 1 });
  });

  it('clears last and sampledAt when a registered root is missing', async () => {
    const usage = await import('./process-usage.ts');
    answer('100 1 100 1\n');
    usage.registerRunProcess('a', 100);
    await tick();
    expect(usage.currentTimedUsage('a')).toEqual({ sampledAt: '2026-09-18T00:00:00.000Z', cpuPct: 1, rssBytes: 102400, procCount: 1 });

    answer('200 1 100 1\n');
    await vi.advanceTimersByTimeAsync(2000);
    expect(usage.currentUsage('a')).toBeUndefined();
    expect(usage.currentTimedUsage('a')).toBeUndefined();
    expect(usage.unregisterRunProcess('a')).toEqual({ peakRssBytes: 102400, peakProcCount: 1 });
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
