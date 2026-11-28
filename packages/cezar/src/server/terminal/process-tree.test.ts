import { afterEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ ps: vi.fn(), psSync: vi.fn(), linux: vi.fn(), linuxSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: io.ps, execFileSync: io.psSync }));
vi.mock('./linux-proc.ts', () => ({ readLinuxProcesses: io.linux, readLinuxProcessTreeSync: io.linuxSync }));

import { processSnapshot, resetProcessSnapshot } from './foreground.ts';
import { descendantGroups, parseTreeRows, readProcessTreeSync } from './process-tree.ts';

const SELF = 100;
const rows = parseTreeRows(`
    1     0     1
  100     1   100
  200   100   200
  300   200   300
  301   300   300
  400   301   400
  garbage line
  900     1   900
`);

describe('descendantGroups', () => {
  it('parses pid, ppid and pgid, skipping malformed rows', () => {
    expect(rows).toHaveLength(7);
    expect(rows[3]).toEqual({ pid: 300, ppid: 200, pgid: 300 });
  });

  it('collects every distinct group under the shell, its own included', () => {
    expect(descendantGroups(rows, 200, SELF)?.sort()).toEqual([200, 300, 400]);
  });

  it('cannot vouch for a pid that is absent or not this process’s own child', () => {
    expect(descendantGroups(rows, 4242, SELF)).toBeNull();
    expect(descendantGroups(rows, 900, SELF)).toBeNull();
    expect(descendantGroups([], 200, SELF)).toBeNull();
  });

  it('never returns cezar’s own group or init’s, even if a descendant claims one', () => {
    const odd = [...rows, { pid: 500, ppid: 200, pgid: 100 }, { pid: 501, ppid: 200, pgid: 1 }, { pid: 502, ppid: 200, pgid: 0 }];
    expect(descendantGroups(odd, 200, SELF)?.sort()).toEqual([200, 300, 400]);
  });

  it('terminates on a table with a parent cycle', () => {
    const cyclic = [...rows, { pid: 200, ppid: 400, pgid: 200 }];
    expect(descendantGroups(cyclic, 200, SELF)?.sort()).toEqual([200, 300, 400]);
  });
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const on = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...platform, value });
afterEach(() => { vi.clearAllMocks(); resetProcessSnapshot(); Object.defineProperty(process, 'platform', platform); });

// Vitest CI runs on Linux only, so the ps path is pinned here with mocks (#2349).
describe('process readers dispatch by platform', () => {
  it('reads and parses ps off Linux, for shutdown and for foreground polling', async () => {
    on('darwin');
    io.psSync.mockReturnValue('  100     1   100\n  200   100   200\ntruncated\n');
    expect(readProcessTreeSync()).toEqual([{ pid: 100, ppid: 1, pgid: 100 }, { pid: 200, ppid: 100, pgid: 200 }]);
    expect(io.psSync).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,pgid='], expect.objectContaining({ timeout: 1_500 }));
    io.ps.mockImplementation((_file, _args, _options, callback) => callback(null, '  200   100 /bin/zsh -l\n'));
    expect(await processSnapshot()).toEqual([{ pid: 200, ppid: 100, command: '/bin/zsh -l' }]);
    expect(io.ps).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,command='], expect.anything(), expect.any(Function));
    expect(io.linux).not.toHaveBeenCalled();
    expect(io.linuxSync).not.toHaveBeenCalled();
  });

  it('answers unknown, never an empty table, when ps fails or hangs', async () => {
    on('darwin');
    io.psSync.mockImplementation(() => { throw new Error('ETIMEDOUT'); });
    expect(readProcessTreeSync()).toBeNull();
    io.ps.mockImplementation((_file, _args, _options, callback) => callback(new Error('ENOENT'), ''));
    expect(await processSnapshot()).toBeNull();
  });

  it('routes Linux through the scoped proc reader and Windows to unknown', async () => {
    on('linux');
    io.linuxSync.mockReturnValue([{ pid: 1, ppid: 0, pgid: 1 }]);
    io.linux.mockResolvedValue([]);
    expect(readProcessTreeSync()).toEqual([{ pid: 1, ppid: 0, pgid: 1 }]);
    expect(await processSnapshot()).toEqual([]);
    on('win32');
    expect(readProcessTreeSync()).toBeNull();
    expect(io.ps).not.toHaveBeenCalled();
    expect(io.psSync).not.toHaveBeenCalled();
  });
});
