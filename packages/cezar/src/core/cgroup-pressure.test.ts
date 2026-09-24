import { describe, expect, it } from 'vitest';

import { createCgroupPressureSource, parsePsiAvg10 } from './cgroup-pressure.ts';
import { levelForSample } from './admission-governor.ts';
import { CGROUP_V1_MEMORY_UNLIMITED_SENTINEL, type CgroupFileReader } from './cgroup-probe.ts';

/**
 * The raw pressure reader (spec `.ai/specs/2026-09-20-adaptive-admission-governor.md` A6).
 *
 * Every fixture is a file map rather than a container, for the same reason the cgroup probe's
 * tests are: CI has no cgroup of its own, and the rules that keep the governor safe - missing rows
 * abstain, `memory.events` is read as a DELTA, nothing ever throws - are exactly the ones a real
 * host makes hard to reach. `createCgroupPressureSource` takes `readFile` and `platform` for this.
 */

function fileReader(files: Record<string, string>): CgroupFileReader {
  return (path) => files[path];
}

function without(files: Record<string, string>, ...paths: string[]): Record<string, string> {
  const copy = { ...files };
  for (const path of paths) delete copy[path];
  return copy;
}

const V2_MOUNTINFO = [
  '29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:9 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot',
].join('\n');

const V1_MOUNTINFO = [
  '25 23 0:24 / /sys/fs/cgroup/cpu,cpuacct rw,nosuid,nodev,noexec,relatime shared:5 - cgroup cgroup rw,cpu,cpuacct',
  '26 23 0:25 / /sys/fs/cgroup/memory rw,nosuid,nodev,noexec,relatime shared:6 - cgroup cgroup rw,memory',
].join('\n');

const V2_LEAF = '/sys/fs/cgroup/system.slice/cezar.service';
const V1_LEAF = '/sys/fs/cgroup/memory/docker/abc';

function v2Files(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    '/proc/self/cgroup': '0::/system.slice/cezar.service\n',
    '/proc/self/mountinfo': V2_MOUNTINFO,
    [`${V2_LEAF}/memory.current`]: '536870912\n', // 512 MiB of a 1 GiB limit
    [`${V2_LEAF}/memory.max`]: '1073741824\n',
    [`${V2_LEAF}/memory.events`]: 'low 0\nhigh 0\nmax 3\noom 0\noom_kill 0\n',
    [`${V2_LEAF}/memory.pressure`]:
      'some avg10=13.37 avg60=1.00 avg300=0.50 total=123456\nfull avg10=1.00 avg60=0.50 avg300=0.25 total=65432\n',
    [`${V2_LEAF}/cpu.pressure`]: 'some avg10=81.25 avg60=20.00 avg300=5.00 total=1234567\n',
    ...overrides,
  };
}

function v1Files(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    '/proc/self/cgroup': '11:cpu,cpuacct:/docker/abc\n12:memory:/docker/abc\n',
    '/proc/self/mountinfo': V1_MOUNTINFO,
    [`${V1_LEAF}/memory.usage_in_bytes`]: '402653184\n', // 384 MiB of a 512 MiB limit
    [`${V1_LEAF}/memory.limit_in_bytes`]: '536870912\n',
    ...overrides,
  };
}

describe('parsePsiAvg10', () => {
  it('reads the `some` row', () => {
    expect(
      parsePsiAvg10(
        'some avg10=13.37 avg60=1.00 avg300=0.50 total=123456\nfull avg10=1.00 avg60=0.50 avg300=0.25 total=65432\n',
      ),
    ).toBe(13.37);
    // Zero is a reading, not a missing one - the source must still report the row.
    expect(parsePsiAvg10('\nsome avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toBe(0);
  });

  it('answers undefined for an absent, full-only or malformed file', () => {
    expect(parsePsiAvg10(undefined)).toBeUndefined();
    expect(parsePsiAvg10('full avg10=99.00 avg60=1.00 avg300=0.50 total=1234\n')).toBeUndefined();
    expect(parsePsiAvg10('some avg10=nonsense avg60=0.00\n')).toBeUndefined();
    expect(parsePsiAvg10('')).toBeUndefined();
  });
});

describe('cgroup v2 pressure source', () => {
  it('reads memory.current against memory.max and both PSI files', () => {
    const source = createCgroupPressureSource({
      readFile: fileReader(v2Files()),
      platform: 'linux',
    });

    expect(source()).toEqual({
      memoryUsedRatio: 0.5,
      memoryPressureAvg10: 13.37,
      cpuPressureAvg10: 81.25,
    });
  });

  it('answers memory.events as a delta: nothing on the first read, the increase afterwards', () => {
    const files = v2Files({
      [`${V2_LEAF}/memory.events`]: 'low 0\nhigh 4\nmax 3\noom 0\noom_kill 3\n',
    });
    const source = createCgroupPressureSource({ readFile: fileReader(files), platform: 'linux' });

    // A machine that BOOTED with `oom_kill: 3` is not pressure happening now.
    const first = source();
    expect(first?.highEventsDelta).toBeUndefined();
    expect(first?.oomKillDelta).toBeUndefined();

    files[`${V2_LEAF}/memory.events`] = 'low 0\nhigh 6\nmax 3\noom 0\noom_kill 4\n';
    const second = source();
    expect(second?.highEventsDelta).toBe(2);
    expect(second?.oomKillDelta).toBe(1);

    // Unchanged counters are a delta of ZERO: no throttle and no kill since the last read.
    const third = source();
    expect(third?.highEventsDelta).toBe(0);
    expect(third?.oomKillDelta).toBe(0);
  });

  it('omits a delta when a counter went backwards instead of reporting a negative one', () => {
    const files = v2Files({
      [`${V2_LEAF}/memory.events`]: 'low 0\nhigh 5\nmax 0\noom 0\noom_kill 0\n',
    });
    const source = createCgroupPressureSource({ readFile: fileReader(files), platform: 'linux' });
    expect(source()?.highEventsDelta).toBeUndefined();

    files[`${V2_LEAF}/memory.events`] = 'low 0\nhigh 1\nmax 0\noom 0\noom_kill 0\n';
    expect(source()?.highEventsDelta).toBeUndefined();
  });

  it('skips the ratio row when memory.max is max (no limit is not 0 % used)', () => {
    const source = createCgroupPressureSource({
      readFile: fileReader(v2Files({ [`${V2_LEAF}/memory.max`]: 'max\n' })),
      platform: 'linux',
    });

    const sample = source();
    expect(sample?.memoryUsedRatio).toBeUndefined();
    // The PSI rows still decide: a missing limit is "no opinion", not "no pressure".
    expect(sample?.memoryPressureAvg10).toBe(13.37);
    expect(sample?.cpuPressureAvg10).toBe(81.25);
  });

  it('decides on the ratio and the events when the container has no PSI files', () => {
    const source = createCgroupPressureSource({
      readFile: fileReader(
        without(v2Files(), `${V2_LEAF}/memory.pressure`, `${V2_LEAF}/cpu.pressure`),
      ),
      platform: 'linux',
    });

    const sample = source();
    expect(sample?.memoryUsedRatio).toBe(0.5);
    expect(sample?.memoryPressureAvg10).toBeUndefined();
    expect(sample?.cpuPressureAvg10).toBeUndefined();
  });

  it('excludes reclaimable page cache, so a cache-heavy container reads as calm', () => {
    // cgroup v2 charges page cache to the cgroup, so 960 MiB of `memory.current` against a 1 GiB
    // limit looks like 94 % - but 900 MiB of it is `inactive_file` the kernel reclaims rather than
    // stalling. The governor must see the 60 MiB that is actually held.
    const files = without(
      v2Files({
        [`${V2_LEAF}/memory.current`]: `${960 * 1024 * 1024}\n`,
        [`${V2_LEAF}/memory.max`]: `${1024 * 1024 * 1024}\n`,
        [`${V2_LEAF}/memory.stat`]:
          'anon 62914560\nfile 943718400\ninactive_file 943718400\nactive_file 0\n',
      }),
      // No PSI in the fixture: the ratio is the only signal, which is the case this pins.
      `${V2_LEAF}/memory.pressure`,
      `${V2_LEAF}/cpu.pressure`,
    );
    const source = createCgroupPressureSource({ readFile: fileReader(files), platform: 'linux' });

    const sample = source();
    expect(sample?.memoryUsedRatio).toBeCloseTo(0.0586, 3);
    expect(levelForSample(sample)).toBe('normal');
  });

  it('falls back to the raw usage when memory.stat is unreadable', () => {
    // A cgroup that will not hand over `memory.stat` is not evidence of calm: the raw ratio is the
    // conservative reading, and the card's own probe makes the same choice.
    const source = createCgroupPressureSource({
      readFile: fileReader(without(v2Files(), `${V2_LEAF}/memory.stat`)),
      platform: 'linux',
    });
    expect(source()?.memoryUsedRatio).toBe(0.5);
  });

  it('resolves the leaf once per source instead of re-parsing mountinfo every sweep', () => {
    const files = v2Files();
    const reads = new Map<string, number>();
    const counting: CgroupFileReader = (path) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return files[path];
    };
    const source = createCgroupPressureSource({ readFile: counting, platform: 'linux' });

    expect(source()?.memoryUsedRatio).toBe(0.5);
    expect(source()?.memoryUsedRatio).toBe(0.5);
    expect(reads.get('/proc/self/mountinfo')).toBe(1);
    expect(reads.get('/proc/self/cgroup')).toBe(1);
    // The cache is the RESOLUTION, not the sample: the per-sweep rows are still re-read.
    expect(reads.get(`${V2_LEAF}/memory.current`)).toBe(2);
  });

  it('does not memoize an unreadable /proc, so a container that becomes readable is picked up', () => {
    const files: Record<string, string> = {};
    const source = createCgroupPressureSource({
      readFile: (path) => files[path],
      platform: 'linux',
    });
    expect(source()).toBeUndefined();

    Object.assign(files, v2Files());
    expect(source()?.memoryUsedRatio).toBe(0.5);
  });

  it('answers events alone when the leaf has no limit and no PSI', () => {
    const readable = without(
      v2Files({
        [`${V2_LEAF}/memory.max`]: 'max\n',
        [`${V2_LEAF}/memory.events`]: 'low 0\nhigh 1\nmax 1\noom 0\noom_kill 0\n',
      }),
      `${V2_LEAF}/memory.pressure`,
      `${V2_LEAF}/cpu.pressure`,
    );
    const source = createCgroupPressureSource({ readFile: fileReader(readable), platform: 'linux' });

    const first = source();
    expect(first).toBeDefined();
    expect(first?.memoryUsedRatio).toBeUndefined();
    expect(first?.highEventsDelta).toBeUndefined();

    readable[`${V2_LEAF}/memory.events`] = 'low 0\nhigh 2\nmax 1\noom 0\noom_kill 0\n';
    expect(source()?.highEventsDelta).toBe(1);
  });

  it('answers undefined when the leaf carries no readable row at all', () => {
    const files = without(
      v2Files({ [`${V2_LEAF}/memory.max`]: 'max\n' }),
      `${V2_LEAF}/memory.events`,
      `${V2_LEAF}/memory.pressure`,
      `${V2_LEAF}/cpu.pressure`,
    );
    const source = createCgroupPressureSource({ readFile: fileReader(files), platform: 'linux' });
    expect(source()).toBeUndefined();
  });

  it('answers undefined on a non-Linux platform, without reading anything', () => {
    let reads = 0;
    const counting: CgroupFileReader = (path) => {
      reads += 1;
      return v2Files()[path];
    };

    const nonLinux = createCgroupPressureSource({ readFile: counting, platform: 'darwin' });
    expect(nonLinux()).toBeUndefined();
    expect(reads).toBe(0);

    const noProc = createCgroupPressureSource({ readFile: fileReader({}), platform: 'linux' });
    expect(noProc()).toBeUndefined();
  });

  it('never throws: a failing read degrades to an unreadable machine', () => {
    const exploding: CgroupFileReader = () => {
      throw new Error('EACCES');
    };
    const source = createCgroupPressureSource({ readFile: exploding, platform: 'linux' });
    expect(() => source()).not.toThrow();
    expect(source()).toBeUndefined();

    // A single file that throws still answers `undefined` - the sample is all-or-nothing, which is
    // the governor's fail-open input. (The default reader swallows a missing file per row; only an
    // injected reader can throw, and even then nothing escapes.)
    const partiallyExploding: CgroupFileReader = (path) => {
      if (path.endsWith('.pressure')) throw new Error('EACCES');
      return v2Files()[path];
    };
    const tolerant = createCgroupPressureSource({
      readFile: partiallyExploding,
      platform: 'linux',
    });
    expect(() => tolerant()).not.toThrow();
    expect(tolerant()).toBeUndefined();
  });
});

describe('cgroup v1 pressure source', () => {
  it('reads usage against the limit on the memory controller mount', () => {
    const source = createCgroupPressureSource({ readFile: fileReader(v1Files()), platform: 'linux' });
    expect(source()).toEqual({ memoryUsedRatio: 0.75 });
  });

  it('subtracts total_inactive_file on cgroup v1', () => {
    const files = v1Files({
      [`${V1_LEAF}/memory.stat`]: 'total_cache 402653184\ntotal_inactive_file 402653184\n',
    });
    const source = createCgroupPressureSource({ readFile: fileReader(files), platform: 'linux' });

    // 384 MiB of usage, all of it reclaimable cache, against a 512 MiB limit.
    expect(source()?.memoryUsedRatio).toBe(0);
  });

  it('answers no ratio for the v1 unlimited sentinel and for a missing limit file', () => {
    const unlimited = createCgroupPressureSource({
      readFile: fileReader(
        v1Files({
          [`${V1_LEAF}/memory.limit_in_bytes`]: `${CGROUP_V1_MEMORY_UNLIMITED_SENTINEL}\n`,
        }),
      ),
      platform: 'linux',
    });
    expect(unlimited()).toBeUndefined();

    const noLimit = createCgroupPressureSource({
      readFile: fileReader(without(v1Files(), `${V1_LEAF}/memory.limit_in_bytes`)),
      platform: 'linux',
    });
    expect(noLimit()).toBeUndefined();
  });
});
