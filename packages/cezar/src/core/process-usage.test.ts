import { describe, expect, it } from 'vitest';

import { aggregateTreeUsage, parsePsOutput } from './process-usage.js';

describe('parsePsOutput', () => {
  it('parses the unix `ps` shape (pid ppid rssKb cpu)', () => {
    const rows = parsePsOutput('  100   1  20480  3.5\n  101 100  10240  1.0\n');
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rssKb: 20480, cpuPct: 3.5 },
      { pid: 101, ppid: 100, rssKb: 10240, cpuPct: 1.0 },
    ]);
  });

  it('parses the Windows PowerShell shape (pid ppid rssKb 0) — same columns, cpu 0', () => {
    // Get-CimInstance Win32_Process emits "PID PPID WorkingSetKB 0".
    const rows = parsePsOutput('4321 4000 51200 0\n4400 4321 12000 0\n');
    expect(rows.map((r) => [r.pid, r.ppid, r.rssKb])).toEqual([
      [4321, 4000, 51200],
      [4400, 4321, 12000],
    ]);
    expect(rows.every((r) => r.cpuPct === 0)).toBe(true);
  });

  it('skips malformed / truncated rows', () => {
    expect(parsePsOutput('garbage\n100 1\n200 1 4096 2.0')).toEqual([
      { pid: 200, ppid: 1, rssKb: 4096, cpuPct: 2.0 },
    ]);
  });
});

describe('aggregateTreeUsage', () => {
  const procs = parsePsOutput(
    ['500 1 100000 10', '501 500 50000 5', '502 501 25000 2', '900 1 999999 99'].join('\n'),
  );

  it('sums RSS over the whole descendant tree, in bytes', () => {
    const usage = aggregateTreeUsage(procs, 500);
    // (100000 + 50000 + 25000) KB * 1024
    expect(usage?.rssBytes).toBe(175000 * 1024);
    expect(usage?.procCount).toBe(3);
  });

  it('returns null when the root pid is gone (no data, not zero)', () => {
    expect(aggregateTreeUsage(procs, 12345)).toBeNull();
  });

  it('does not pull in unrelated trees', () => {
    // pid 900 (999999 KB) is a sibling under init, not under 500 — must not be counted.
    expect(aggregateTreeUsage(procs, 500)?.rssBytes).toBe(175000 * 1024);
  });
});
