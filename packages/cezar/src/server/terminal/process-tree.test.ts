import { describe, expect, it } from 'vitest';

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

describe('readProcessTreeSync', () => {
  it('answers rows or null, and never throws', () => {
    const table = readProcessTreeSync();
    if (table !== null) expect(table.some((row) => row.pid === process.pid)).toBe(true);
  });
});
