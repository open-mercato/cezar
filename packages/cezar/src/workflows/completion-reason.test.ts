import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { completionReason } from './completion-reason.ts';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-completion-'));
  directories.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(dir, 'file.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'cez/task');
  const store = RunStore.open(join(dir, '.git', 'cezar-test'));
  const run = store.createRun({ title: 'test', task: 'test', workflow: 'test', steps: [] });
  Object.assign(run, { worktreePath: dir, baseBranch: 'main', branch: 'cez/task', startedAt: new Date().toISOString() });
  const commitChange = () => {
    writeFileSync(join(dir, 'file.txt'), 'after\n');
    git('add', '.');
    git('commit', '-qm', 'task change');
  };
  return { git, run, commitChange };
}

describe('webhook completion evidence', () => {
  it('does not claim no changes for committed work on detached HEAD with a start instant', async () => {
    const { git, run, commitChange } = fixture();
    git('checkout', '-q', '--detach');
    commitChange();
    expect(git('diff', '--name-only', 'main')).toBe('file.txt');
    expect(await completionReason(run)).toBe('completed');
  });

  it('does not treat an invalid start instant as a trustworthy repointed baseline', async () => {
    const { git, run, commitChange } = fixture();
    git('checkout', '-qb', 'other');
    commitChange();
    run.startedAt = 'invalid';
    expect(await completionReason(run)).toBe('completed');
  });

  it('still identifies a clean task branch as no changes', async () => {
    expect(await completionReason(fixture().run)).toBe('no_changes');
  });

  it('does not claim no changes when the repointed branch has no reflog', async () => {
    const { git, run, commitChange } = fixture();
    git('checkout', '-qb', 'other');
    commitChange();
    rmSync(join(run.worktreePath!, '.git', 'logs', 'refs', 'heads', 'other'));
    expect(await completionReason(run)).toBe('completed');
  });

  it('still identifies committed work on the task branch as completed', async () => {
    const { run, commitChange } = fixture();
    commitChange();
    expect(await completionReason(run)).toBe('completed');
  });
});
