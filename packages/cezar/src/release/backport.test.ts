import { describe, expect, it } from 'vitest';
import { backportBranch, planBackports, type BackportState } from './backport.ts';

const LINE = 'release/v0.16.x';
const branches = new Set(['main', LINE]);
const plan = (pulls: Parameters<typeof planBackports>[0]['pulls'], existing: [string, BackportState][] = []) =>
  planBackports({ pulls, existing: new Map(existing), branches });

describe('planBackports', () => {
  it('queues a labelled PR whatever repository it came from — the scan never sees a fork', () => {
    expect(plan([{ number: 1694, base: 'main', labels: ['bug', `backport ${LINE}`] }])).toEqual([{ pr: 1694, target: LINE }]);
  });

  it('skips a target whose backport PR is open or merged, and reopens one that was only closed', () => {
    const pulls = [
      { number: 1, base: 'main', labels: [`backport ${LINE}`] },
      { number: 2, base: 'main', labels: [`backport ${LINE}`] },
      { number: 3, base: 'main', labels: [`backport ${LINE}`] },
    ];
    const existing: [string, BackportState][] = [
      [backportBranch(1, LINE), 'open'],
      [backportBranch(2, LINE), 'merged'],
      [backportBranch(3, LINE), 'closed'],
    ];
    expect(plan(pulls, existing)).toEqual([{ pr: 3, target: LINE }]);
  });

  it('holds a closed backport while its branch is kept — the action would reopen that stale branch', () => {
    const pulls = [{ number: 4, base: 'main', labels: [`backport ${LINE}`] }];
    expect(plan(pulls, [[backportBranch(4, LINE), 'closed-branch-kept']])).toEqual([]);
  });

  it('forward-ports a line hotfix to main, never to the branch it merged into', () => {
    expect(plan([{ number: 9, base: LINE, labels: ['backport main', `backport ${LINE}`] }])).toEqual([{ pr: 9, target: 'main' }]);
  });

  it('ignores lookalike labels and targets that are not branches', () => {
    expect(
      plan([{ number: 5, base: 'main', labels: ['backport', 'backport release/v0.9.x', 'backport release/v0.15.x', 'backport feature/x'] }]),
    ).toEqual([]);
  });
});
