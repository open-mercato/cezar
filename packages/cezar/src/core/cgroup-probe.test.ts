import { describe, expect, it } from 'vitest';

import {
  ancestorChain,
  CGROUP_V1_MEMORY_UNLIMITED_SENTINEL,
  countCpuList,
  createCgroupProbe,
  parseCpuQuotaCores,
  parseMemoryLimitBytes,
  parseMountInfo,
  parseUnifiedCgroupPath,
  type CgroupFileReader,
} from './cgroup-probe.ts';

/**
 * The cgroup probe (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, Phase 1).
 *
 * Every fixture here is a shape a real host produces - the dev-host counterexample, a Docker
 * `--cpuset-cpus` pin, a systemd-limited ancestor, the v1 sentinels - because CI machines have no
 * container, which is exactly why these tests are file-driven rather than environment-driven.
 */
function fileReader(files: Record<string, string>): CgroupFileReader {
  return (path) => files[path];
}

const V2_MOUNTINFO = [
  '29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:9 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot',
].join('\n');

const V1_MOUNTINFO = [
  '25 23 0:24 / /sys/fs/cgroup/cpu,cpuacct rw,nosuid,nodev,noexec,relatime shared:5 - cgroup cgroup rw,cpu,cpuacct',
  '26 23 0:25 / /sys/fs/cgroup/memory rw,nosuid,nodev,noexec,relatime shared:6 - cgroup cgroup rw,memory',
].join('\n');

describe('cgroup file parsers', () => {
  it('reads the unified path out of /proc/self/cgroup', () => {
    expect(parseUnifiedCgroupPath('0::/user.slice/user-1000.slice/session-9579.scope\n')).toBe(
      '/user.slice/user-1000.slice/session-9579.scope',
    );
    expect(parseUnifiedCgroupPath('0::/')).toBe('/');
    expect(parseUnifiedCgroupPath('11:cpu,cpuacct:/docker/abc\n')).toBeUndefined();
  });

  it('parses a mount table entry rather than assuming a mount point', () => {
    const rows = parseMountInfo(V1_MOUNTINFO);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      mountPoint: '/sys/fs/cgroup/cpu,cpuacct',
      fileSystem: 'cgroup',
      superOptions: 'rw,cpu,cpuacct',
    });
  });

  it('counts CPU lists as ranges, and never invents cores', () => {
    expect(countCpuList('0-2,4-6,8')).toBe(7);
    expect(countCpuList('4,6')).toBe(2);
    expect(countCpuList('0-3\n')).toBe(4);
    expect(countCpuList('')).toBeUndefined();
    expect(countCpuList(undefined)).toBeUndefined();
    expect(countCpuList('nonsense')).toBeUndefined();
  });

  it('treats every unlimited spelling as unlimited, and a numeric zero as a zero limit', () => {
    expect(parseCpuQuotaCores('max 100000', undefined)).toBeUndefined();
    expect(parseCpuQuotaCores('-1', 100000)).toBeUndefined();
    expect(parseCpuQuotaCores('0', 100000)).toBeUndefined();
    expect(parseCpuQuotaCores('200000 100000', undefined)).toBeCloseTo(2);
    expect(parseCpuQuotaCores('50000', 100000)).toBeCloseTo(0.5);

    expect(parseMemoryLimitBytes('max')).toBeUndefined();
    expect(parseMemoryLimitBytes('-1')).toBeUndefined();
    expect(parseMemoryLimitBytes(String(CGROUP_V1_MEMORY_UNLIMITED_SENTINEL))).toBeUndefined();
    expect(parseMemoryLimitBytes('0')).toBeUndefined();
    expect(parseMemoryLimitBytes('536870912')).toBe(536_870_912);
  });

  it('walks a leaf up to its mount root and stops there', () => {
    expect(ancestorChain('/sys/fs/cgroup/a/b/c', '/sys/fs/cgroup')).toEqual([
      '/sys/fs/cgroup/a/b/c',
      '/sys/fs/cgroup/a/b',
      '/sys/fs/cgroup/a',
      '/sys/fs/cgroup',
    ]);
    expect(ancestorChain('/sys/fs/cgroup', '/sys/fs/cgroup')).toEqual(['/sys/fs/cgroup']);
  });
});

describe('cgroup v2 probe', () => {
  it('reports usage but NO limit for a normal host process (the dev-host counterexample)', () => {
    const probe = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '0::/user.slice/user-1000.slice/session-9579.scope\n',
        '/proc/self/mountinfo': V2_MOUNTINFO,
        '/sys/fs/cgroup/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/sys/fs/cgroup/user.slice/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/user.slice/memory.max': 'max\n',
        '/sys/fs/cgroup/user.slice/user-1000.slice/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/user.slice/user-1000.slice/memory.max': 'max\n',
        '/sys/fs/cgroup/user.slice/user-1000.slice/session-9579.scope/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/user.slice/user-1000.slice/session-9579.scope/memory.max': 'max\n',
        '/sys/fs/cgroup/user.slice/user-1000.slice/session-9579.scope/memory.current':
          '1708724224\n',
        '/sys/fs/cgroup/user.slice/user-1000.slice/session-9579.scope/memory.stat':
          'anon 100\ninactive_file 424242\n',
        '/sys/fs/cgroup/user.slice/user-1000.slice/session-9579.scope/cpu.stat':
          'usage_usec 9262860895\nuser_usec 7070563520\n',
      }),
      platform: 'linux',
    });

    const facts = probe();
    expect(facts?.source).toBe('cgroup-v2');
    // Usage is readable and cache-excluded, but no finite limit exists anywhere on the chain, so
    // the sampler emits no container at all - the v1 payload stays byte-identical.
    expect(facts?.cpuQuotaCores).toBeUndefined();
    expect(facts?.memLimitBytes).toBeUndefined();
    expect(facts?.memUsedBytes).toBe(1_708_724_224 - 424_242);
    expect(facts?.cpuUsageUs).toBe(9_262_860_895);
  });

  it('finds a limit that lives on an ancestor cgroup, not the leaf', () => {
    const probe = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '0::/system.slice/cezar.service\n',
        '/proc/self/mountinfo': V2_MOUNTINFO,
        '/sys/fs/cgroup/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/sys/fs/cgroup/system.slice/cpu.max': '400000 100000\n',
        '/sys/fs/cgroup/system.slice/memory.max': '8589934592\n',
        '/sys/fs/cgroup/system.slice/cezar.service/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/system.slice/cezar.service/memory.max': 'max\n',
      }),
      platform: 'linux',
    });

    const facts = probe();
    expect(facts?.cpuQuotaCores).toBeCloseTo(4);
    expect(facts?.memLimitBytes).toBe(8_589_934_592);
  });

  it('treats a cpuset pin as a finite CPU limit and a numeric zero memory limit as no limit', () => {
    const probe = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '0::/\n',
        '/proc/self/mountinfo': V2_MOUNTINFO,
        '/sys/fs/cgroup/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/memory.max': '0\n',
        '/sys/fs/cgroup/cpuset.cpus.effective': '4,6\n',
        '/sys/fs/cgroup/cpu.stat': 'usage_usec 1000\n',
      }),
      platform: 'linux',
    });

    const facts = probe();
    expect(facts?.cpusetCores).toBe(2);
    expect(facts?.cpuQuotaCores).toBeUndefined();
    // The zero limit is degenerate and non-positive: it must not become an "unlimited" host claim.
    expect(facts?.memLimitBytes).toBeUndefined();
  });

  it('falls back to cpuset.cpus when the effective file is absent or empty', () => {
    const probe = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '0::/\n',
        '/proc/self/mountinfo': V2_MOUNTINFO,
        '/sys/fs/cgroup/cpuset.cpus.effective': '\n',
        '/sys/fs/cgroup/cpuset.cpus': '0-2,4-6,8,18\n',
      }),
      platform: 'linux',
    });

    expect(probe()?.cpusetCores).toBe(8);
  });

  it('finds a cpuset pin that lives on an ANCESTOR, where the leaf has no cpuset files at all', () => {
    // Review minor: the leaf's `cpuset.cpus.effective` folds its ancestors, but a leaf whose cgroup
    // does not enable the cpuset controller exposes NO such file - and the pin on the ancestor was
    // then missed entirely, reporting the full host core count for a pinned process.
    const probe = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '0::/system.slice/cezar.service\n',
        '/proc/self/mountinfo': V2_MOUNTINFO,
        '/sys/fs/cgroup/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/sys/fs/cgroup/system.slice/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/system.slice/memory.max': 'max\n',
        // The pin sits here, two levels above the leaf.
        '/sys/fs/cgroup/system.slice/cpuset.cpus.effective': '4,6\n',
        '/sys/fs/cgroup/system.slice/cezar.service/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/system.slice/cezar.service/memory.max': 'max\n',
      }),
      platform: 'linux',
    });

    expect(probe()?.cpusetCores).toBe(2);
  });

  it('keeps the tightest cpuset when several levels expose one', () => {
    const probe = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '0::/a/b\n',
        '/proc/self/mountinfo': V2_MOUNTINFO,
        '/sys/fs/cgroup/a/b/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/a/b/memory.max': 'max\n',
        '/sys/fs/cgroup/a/cpuset.cpus.effective': '0-3\n',
        '/sys/fs/cgroup/a/b/cpuset.cpus.effective': '0-1\n',
      }),
      platform: 'linux',
    });

    expect(probe()?.cpusetCores).toBe(2);
  });

  it('answers nothing when /proc is unreadable or the platform is not Linux', () => {
    expect(createCgroupProbe({ readFile: () => undefined, platform: 'linux' })()).toBeUndefined();
    expect(createCgroupProbe({ readFile: fileReader({}), platform: 'darwin' })()).toBeUndefined();
  });
});

describe('cgroup v1 probe', () => {
  const v1Files = (overrides: Record<string, string> = {}): Record<string, string> => ({
    '/proc/self/cgroup': '11:cpu,cpuacct:/docker/abc\n12:memory:/docker/abc\n',
    '/proc/self/mountinfo': V1_MOUNTINFO,
    '/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_quota_us': '200000\n',
    '/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_period_us': '100000\n',
    '/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpuacct.usage': '3000000000\n',
    '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes': '536870912\n',
    '/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes': '402653184\n',
    '/sys/fs/cgroup/memory/docker/abc/memory.stat': 'cache 10\ntotal_inactive_file 1048576\n',
    ...overrides,
  });

  it('resolves per-controller mounts and converts nanoseconds to microseconds', () => {
    const facts = createCgroupProbe({ readFile: fileReader(v1Files()), platform: 'linux' })();
    expect(facts?.source).toBe('cgroup-v1');
    expect(facts?.cpuQuotaCores).toBeCloseTo(2);
    expect(facts?.memLimitBytes).toBe(536_870_912);
    expect(facts?.memUsedBytes).toBe(402_653_184 - 1_048_576);
    // `cpuacct.usage` is nanoseconds: 3e9 ns is 3e6 microseconds, not 3e9.
    expect(facts?.cpuUsageUs).toBe(3_000_000);
  });

  it('treats the v1 quota and memory sentinels as unlimited', () => {
    const facts = createCgroupProbe({
      readFile: fileReader(
        v1Files({
          '/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_quota_us': '-1\n',
          '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes': `${CGROUP_V1_MEMORY_UNLIMITED_SENTINEL}\n`,
        }),
      ),
      platform: 'linux',
    })();

    expect(facts?.cpuQuotaCores).toBeUndefined();
    expect(facts?.memLimitBytes).toBeUndefined();
  });

  it('degrades to nothing when no controller mount can be resolved', () => {
    expect(
      createCgroupProbe({
        readFile: fileReader({ '/proc/self/cgroup': '11:cpu,cpuacct:/x\n', '/proc/self/mountinfo': '' }),
        platform: 'linux',
      })(),
    ).toBeUndefined();
  });

  it('reads usage from a SEPARATE cpuacct mount, not from the cpu controller mount', () => {
    const facts = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '9:cpu:/docker/abc\n10:cpuacct:/docker/abc\n12:memory:/docker/abc\n',
        '/proc/self/mountinfo': [
          '25 23 0:24 / /sys/fs/cgroup/cpu rw,relatime shared:5 - cgroup cgroup rw,cpu',
          '26 23 0:25 / /sys/fs/cgroup/cpuacct rw,relatime shared:6 - cgroup cgroup rw,cpuacct',
          '27 23 0:26 / /sys/fs/cgroup/memory rw,relatime shared:7 - cgroup cgroup rw,memory',
        ].join('\n'),
        '/sys/fs/cgroup/cpu/docker/abc/cpu.cfs_quota_us': '200000\n',
        '/sys/fs/cgroup/cpu/docker/abc/cpu.cfs_period_us': '100000\n',
        // Only the cpuacct mount carries the counter: a probe that reads it under `cpu` would
        // report the quota with no percentage at all.
        '/sys/fs/cgroup/cpuacct/docker/abc/cpuacct.usage': '2500000000\n',
      }),
      platform: 'linux',
    })();

    expect(facts?.cpuQuotaCores).toBeCloseTo(2);
    expect(facts?.cpuUsageUs).toBe(2_500_000);
  });
});

describe('cgroup v2 + v1 hybrids', () => {
  const HYBRID_MOUNTINFO = [
    '29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:9 - cgroup2 cgroup2 rw,nsdelegate',
    '25 23 0:24 / /sys/fs/cgroup/cpu,cpuacct rw,relatime shared:5 - cgroup cgroup rw,cpu,cpuacct',
  ].join('\n');

  it('falls through to v1 when the unified mount carries usage but NO limit', () => {
    const facts = createCgroupProbe({
      readFile: fileReader({
        // Both hierarchies are mounted; the process's own path on the v1 side holds the quota.
        '/proc/self/cgroup': '0::/system.slice/cezar.service\n11:cpu,cpuacct:/system.slice/cezar.service\n',
        '/proc/self/mountinfo': HYBRID_MOUNTINFO,
        '/sys/fs/cgroup/system.slice/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/system.slice/memory.max': 'max\n',
        '/sys/fs/cgroup/system.slice/cezar.service/cpu.max': 'max 100000\n',
        '/sys/fs/cgroup/system.slice/cezar.service/memory.stat': 'inactive_file 4096\n',
        '/sys/fs/cgroup/cpu,cpuacct/system.slice/cezar.service/cpu.cfs_quota_us': '150000\n',
        '/sys/fs/cgroup/cpu,cpuacct/system.slice/cezar.service/cpu.cfs_period_us': '100000\n',
      }),
      platform: 'linux',
    })();

    // Answering with the v2 facts alone would make the card say "no cgroup limit detected" about a
    // process capped at 1.5 cores - the false negative this fallback exists to prevent.
    expect(facts?.source).toBe('cgroup-v1');
    expect(facts?.cpuQuotaCores).toBeCloseTo(1.5);
  });

  it('keeps the v2 facts when v2 already carries the limit', () => {
    const facts = createCgroupProbe({
      readFile: fileReader({
        '/proc/self/cgroup': '0::/\n11:cpu,cpuacct:/x\n',
        '/proc/self/mountinfo': HYBRID_MOUNTINFO,
        '/sys/fs/cgroup/cpu.max': '200000 100000\n',
        '/sys/fs/cgroup/cpu,cpuacct/x/cpu.cfs_quota_us': '800000\n',
        '/sys/fs/cgroup/cpu,cpuacct/x/cpu.cfs_period_us': '100000\n',
      }),
      platform: 'linux',
    })();

    expect(facts?.source).toBe('cgroup-v2');
    expect(facts?.cpuQuotaCores).toBeCloseTo(2);
  });
});
