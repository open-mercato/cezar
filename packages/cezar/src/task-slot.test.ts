import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TASK_SLOTS, acquireTaskSlot, taskSlotEnv } from './task-slot.ts';

let home: string;
let trees: string;
let env: NodeJS.ProcessEnv;

/** A directory standing in for a task's worktree. */
function tree(name: string): string {
  const path = join(trees, name);
  mkdirSync(path, { recursive: true });
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-slot-home-'));
  trees = mkdtempSync(join(tmpdir(), 'cez-slot-trees-'));
  env = { CEZ_HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(trees, { recursive: true, force: true });
});

describe('acquireTaskSlot', () => {
  it('gives each worktree its own number, lowest first', () => {
    expect(acquireTaskSlot('a', tree('a'), env)).toBe(1);
    expect(acquireTaskSlot('b', tree('b'), env)).toBe(2);
    expect(acquireTaskSlot('c', tree('c'), env)).toBe(3);
  });

  it('answers the same number every time the same task asks', () => {
    const a = tree('a');
    expect(acquireTaskSlot('a', a, env)).toBe(1);
    acquireTaskSlot('b', tree('b'), env);
    expect(acquireTaskSlot('a', a, env)).toBe(1);
    expect(readdirSync(join(home, 'task-slots'))).toHaveLength(2);
  });

  it('frees a slot once its worktree is gone, with nothing having released it', () => {
    const a = tree('a');
    acquireTaskSlot('a', a, env);
    acquireTaskSlot('b', tree('b'), env);
    rmSync(a, { recursive: true });
    expect(acquireTaskSlot('c', tree('c'), env)).toBe(1);
  });

  it('never hands out a slot whose lease it cannot read', () => {
    mkdirSync(join(home, 'task-slots'), { recursive: true });
    writeFileSync(join(home, 'task-slots', '1.json'), '{"runId":');
    expect(acquireTaskSlot('a', tree('a'), env)).toBe(2);
  });

  it('yields no slot when every one is taken', () => {
    const held = tree('held');
    mkdirSync(join(home, 'task-slots'), { recursive: true });
    for (let slot = 1; slot <= MAX_TASK_SLOTS; slot += 1) {
      writeFileSync(join(home, 'task-slots', `${slot}.json`), JSON.stringify({ runId: `r${slot}`, worktree: held }));
    }
    expect(acquireTaskSlot('late', tree('late'), env)).toBeUndefined();
  });

  it('yields no slot, and does not throw, when the home cannot hold one', () => {
    // A FILE where the home directory should be: nothing can be created under it.
    const blocked = join(trees, 'not-a-dir');
    writeFileSync(blocked, '');
    expect(acquireTaskSlot('a', tree('a'), { CEZ_HOME: blocked })).toBeUndefined();
  });
});

describe('taskSlotEnv', () => {
  it('names the slot and its port block', () => {
    acquireTaskSlot('other', tree('other'), env);
    expect(taskSlotEnv('a', tree('a'), env)).toEqual({ CEZ_TASK_SLOT: '2', CEZ_TASK_PORT_BASE: '20200' });
  });

  it('is present and EMPTY for a task with no worktree, so an inherited slot cannot leak in', () => {
    expect(taskSlotEnv('a', undefined, env)).toEqual({ CEZ_TASK_SLOT: '', CEZ_TASK_PORT_BASE: '' });
    expect(readdirSync(home)).toEqual([]);
  });
});
