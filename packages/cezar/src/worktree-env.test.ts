import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorktreeEnvFiles } from './worktree-env.ts';

let repo: string;
let wt: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A linked worktree, like a real run's. */
function makeWorktree(ref = 'HEAD'): string {
  git(repo, 'worktree', 'add', '-q', '--detach', wt, ref);
  return wt;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cez-env-'));
  wt = `${repo}-wt`;
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  put(repo, 'README.md', '# x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'before the ignore rule');
  put(repo, '.gitignore', '.env\n.env.local\nnode_modules/\n');
  put(repo, 'app/.env.example', 'KEY=');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
});

afterEach(() => {
  try {
    git(repo, 'worktree', 'remove', '--force', wt);
  } catch {
    // no worktree was made
  }
  rmSync(repo, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

describe('seedWorktreeEnvFiles', () => {
  it('copies the ignored env files, at any depth, and leaves the worktree clean', async () => {
    put(repo, '.env', 'ROOT=1');
    put(repo, 'app/packages/api/.env', 'STRIPE_API_KEY=sk_test');
    put(repo, 'app/apps/storefront/.env.local', 'NEXT=1');
    makeWorktree();

    const seeded = await seedWorktreeEnvFiles(repo, wt, {});
    expect(seeded.sort()).toEqual(['.env', 'app/apps/storefront/.env.local', 'app/packages/api/.env']);
    expect(readFileSync(join(wt, 'app/packages/api/.env'), 'utf8')).toBe('STRIPE_API_KEY=sk_test');
    // Nothing an autosave's `git add -A` could pick up.
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('leaves tracked env files to the branch, and unignored ones alone', async () => {
    put(repo, 'app/.env.example', 'KEY=changed-locally');
    put(repo, 'app/.env.staging', 'NOT_IGNORED=1');
    makeWorktree();

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
    expect(readFileSync(join(wt, 'app/.env.example'), 'utf8')).toBe('KEY=');
    expect(existsSync(join(wt, 'app/.env.staging'))).toBe(false);
  });

  it('never overwrites an env file the worktree already has', async () => {
    put(repo, '.env', 'PORT=3000');
    makeWorktree();
    put(wt, '.env', 'PORT=3107');

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('PORT=3107');
  });

  it('skips dependency trees and other checkouts', async () => {
    put(repo, 'node_modules/pkg/.env', 'FIXTURE=1');
    put(repo, 'nested/.git', 'gitdir: elsewhere');
    put(repo, 'nested/.env', 'OTHER_REPO=1');
    put(repo, '.git/info/exclude', 'nested/\n');
    makeWorktree();

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
  });

  it('excludes a copy the worktree’s own branch would not ignore', async () => {
    put(repo, '.env', 'SECRET=1');
    // The commit before `.gitignore` existed: in this tree nothing says `.env` is ignored.
    makeWorktree('HEAD~1');

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual(['.env']);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('SECRET=1');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('copies nothing when there is nothing to copy', async () => {
    makeWorktree();
    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
  });

  it('is off under CEZ_WORKTREE_ENV=0, and for a run in the repo itself', async () => {
    put(repo, '.env', 'ROOT=1');
    makeWorktree();

    expect(await seedWorktreeEnvFiles(repo, wt, { CEZ_WORKTREE_ENV: '0' })).toEqual([]);
    expect(existsSync(join(wt, '.env'))).toBe(false);
    expect(await seedWorktreeEnvFiles(repo, repo, {})).toEqual([]);
  });

  it('does not throw outside a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-env-plain-'));
    try {
      expect(await seedWorktreeEnvFiles(repo, plain, {})).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
