import { describe, expect, it } from 'vitest';

import { gitInFlightCount, gitSingleFlight } from './git-single-flight.ts';

/** A spawn the test resolves by hand, counting how many processes were really started. */
function deferredSpawns() {
  const pending: Array<(v: string) => void> = [];
  let started = 0;
  const spawn = () => {
    started += 1;
    const n = started;
    return new Promise<string>((resolve) => pending.push(() => resolve(`run-${n}`)));
  };
  return { spawn, pending, started: () => started };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('gitSingleFlight', () => {
  // The live incident: polls arriving while a slow `git status` ran each spawned another one.
  it('runs at most one process plus one queued follow-up for any number of identical reads', async () => {
    const { spawn, pending, started } = deferredSpawns();
    const first = gitSingleFlight('/wt', ['status', '--porcelain', '-z'], false, spawn);
    const later = Array.from({ length: 10 }, () =>
      gitSingleFlight('/wt', ['status', '--porcelain', '-z'], false, spawn));
    expect(started()).toBe(1);
    pending.shift()!('');
    expect(await first).toBe('run-1');
    await tick();
    expect(started()).toBe(2);
    pending.shift()!('');
    // Every caller that arrived during run 1 gets run 2 — a process that began after it asked.
    expect(await Promise.all(later)).toEqual(Array(10).fill('run-2'));
    expect(gitInFlightCount()).toBe(0);
  });

  it('never hands a later caller the result of a process that started before it asked', async () => {
    const { spawn, pending } = deferredSpawns();
    const early = gitSingleFlight('/wt', ['diff', 'main'], false, spawn);
    const late = gitSingleFlight('/wt', ['diff', 'main'], false, spawn);
    pending.shift()!('');
    await early;
    await tick();
    pending.shift()!('');
    expect(await late).toBe('run-2');
  });

  it('keeps different directories and different arguments apart', async () => {
    const { spawn, pending, started } = deferredSpawns();
    const all = [
      gitSingleFlight('/a', ['status', '--porcelain'], false, spawn),
      gitSingleFlight('/b', ['status', '--porcelain'], false, spawn),
      gitSingleFlight('/a', ['status', '--porcelain', '-z'], false, spawn),
    ];
    expect(started()).toBe(3);
    pending.splice(0).forEach((resolve) => resolve(''));
    await Promise.all(all);
  });

  it.each([
    [['commit', '-m', 'x']],
    [['add', '-A']],
    [['push']],
    [['branch', '-D', 'cez/x']],
    [['worktree', 'add', '/x']],
    [['checkout', 'main']],
  ])('never coalesces a write: %j', async (args) => {
    const { spawn, pending, started } = deferredSpawns();
    const both = [gitSingleFlight('/wt', args, false, spawn), gitSingleFlight('/wt', args, false, spawn)];
    expect(started()).toBe(2);
    pending.splice(0).forEach((resolve) => resolve(''));
    await Promise.all(both);
  });

  it('never coalesces a call with its own env (a scratch index means a different answer)', async () => {
    const { spawn, pending, started } = deferredSpawns();
    const both = [
      gitSingleFlight('/wt', ['add', '-N', '.'], true, spawn),
      gitSingleFlight('/wt', ['add', '-N', '.'], true, spawn),
    ];
    expect(started()).toBe(2);
    pending.splice(0).forEach((resolve) => resolve(''));
    await Promise.all(both);
  });

  it('a failed run still releases its queued follow-up', async () => {
    let n = 0;
    const spawn = () => (++n === 1 ? Promise.reject(new Error('index.lock')) : Promise.resolve('ok'));
    const first = gitSingleFlight('/wt', ['status'], false, spawn);
    const second = gitSingleFlight('/wt', ['status'], false, spawn);
    await expect(first).rejects.toThrow('index.lock');
    await expect(second).resolves.toBe('ok');
    expect(gitInFlightCount()).toBe(0);
  });
});
