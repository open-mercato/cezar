import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SHALLOW_HISTORY_HINT, createWorktree, isShallowRepository, syncWithBase } from './git-worktree.ts';
import { SHARED_GIT_HISTORY_PROMPT, sharedGitHistoryPromptPart } from './workflows/run.ts';

const run = promisify(execFile);
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@local'];
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5 }); });

async function g(cwd: string, ...args: string[]) { return run('git', [...ID, ...args], { cwd }); }
async function commits(cwd: string, n: number, tag: string) {
  for (let i = 0; i < n; i++) { writeFileSync(join(cwd, `${tag}${i}.txt`), `${i}\n`); await g(cwd, 'add', '-A'); await g(cwd, 'commit', '-q', '-m', `${tag}${i}`); }
}

// #2180: a depth-limited fetch inside a linked worktree shortens the SHARED history.
describe('shared shallow history (#2180)', () => {
  it('the prompt guard is added for worktree runs only', () => {
    expect(sharedGitHistoryPromptPart('/r/wt', '/r')).toBe(SHARED_GIT_HISTORY_PROMPT);
    expect(sharedGitHistoryPromptPart('/r', '/r')).toBeUndefined();
    expect(SHARED_GIT_HISTORY_PROMPT).toContain('--depth');
  });

  it('syncWithBase reports shallow ancestry apart from genuine divergence', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cez-shallow-'));
    roots.push(base);
    const remote = join(base, 'remote.git');
    const seed = join(base, 'seed');
    const primary = join(base, 'primary');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await run('git', ['clone', '-q', remote, seed]);
    await g(seed, 'checkout', '-q', '-b', 'main');
    await commits(seed, 6, 'a');
    await g(seed, 'push', '-q', 'origin', 'main');
    await run('git', ['clone', '-q', remote, primary]);
    expect(await isShallowRepository(primary)).toBe(false);
    const wt = await createWorktree(primary, 'c36f0570-aaaa-bbbb-cccc-000000000001', 'main');
    const wtPath = wt.path;
    await commits(seed, 6, 'b');
    await g(seed, 'push', '-q', 'origin', 'main');
    const tip = (await g(seed, 'rev-parse', 'HEAD')).stdout.trim();
    // The dangerous agent command, run inside the task worktree.
    await g(wtPath, 'fetch', '--no-tags', '--depth=2', 'origin', tip);
    expect(await isShallowRepository(primary)).toBe(true);
    // Ordinary fetches never make a full repo shallow.
    expect(await isShallowRepository(resolve(seed))).toBe(false);
    // The task's own work diverges from a base whose ancestry is hidden.
    await commits(wtPath, 1, 'task');
    await g(primary, 'fetch', '-q', 'origin');
    const res = await syncWithBase(wtPath, 'main');
    expect(res).toEqual({ result: 'failed', error: SHALLOW_HISTORY_HINT });
  });
});
