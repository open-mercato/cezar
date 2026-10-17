import { exec, execFile } from 'node:child_process';
import { gitHasIdentity, taskRemotes } from '../git-worktree.ts';
import { isSafeGitRef } from '../git-refs.ts';

/**
 * Self-merge for direct-landing projects (`config.selfMerge`, agents-master I050 "Closer 2").
 *
 * Merges a finished task branch `--no-ff` into the base branch IN THE MAIN CHECKOUT, runs the
 * project's `checkCommand` on the merged tree before committing, and pushes. Every refusal leaves
 * the base exactly where it was: the merge is made with `--no-commit`, so a conflict or a failed
 * check is undone by `git merge --abort`. Never throws.
 */

export const SELF_MERGE_CHECK_TIMEOUT_MS = 30 * 60_000;
const PUSH_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL = 600;

export type SelfMergeResult =
  /** The branch has no commits the base lacks — nothing to land. */
  | { outcome: 'nothing' }
  | { outcome: 'merged'; sha: string; base: string; checked: boolean; pushedTo?: string }
  /** The base is untouched — unless `sha` is set: then the merge landed locally and only the push failed. */
  | { outcome: 'blocked'; reason: string; sha?: string };

export interface SelfMergeInput {
  repoRoot: string;
  /** The task worktree; its tracked changes would be lost with it, so they block. */
  worktreePath: string;
  branch: string;
  base: string;
  checkCommand?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}

export async function selfMergeBranch(input: SelfMergeInput): Promise<SelfMergeResult> {
  const { repoRoot, worktreePath, branch, base } = input;
  if (!isSafeGitRef(branch) || !isSafeGitRef(base)) return { outcome: 'blocked', reason: `"${base}" or "${branch}" is not a usable branch name` };
  if (!(await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])).ok) {
    return { outcome: 'blocked', reason: `the base branch "${base}" does not exist in the main checkout` };
  }
  const ahead = await git(repoRoot, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${branch}`]);
  if (!ahead.ok) return { outcome: 'blocked', reason: `could not compare "${branch}" with "${base}": ${tail(ahead.stderr)}` };
  if (Number.parseInt(ahead.stdout.trim(), 10) === 0) return { outcome: 'nothing' };

  const worktreeDirty = await git(worktreePath, ['status', '--porcelain', '--untracked-files=no']);
  if (worktreeDirty.ok && worktreeDirty.stdout.trim()) {
    return { outcome: 'blocked', reason: 'the task worktree has uncommitted changes' };
  }
  const head = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const current = head.ok ? head.stdout.trim() : '';
  if (current !== base) {
    return { outcome: 'blocked', reason: `the main checkout is on ${current ? `"${current}"` : 'a detached HEAD'}, not "${base}"` };
  }
  const dirty = await git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (!dirty.ok || dirty.stdout.trim()) {
    return { outcome: 'blocked', reason: 'the main checkout has uncommitted changes to tracked files' };
  }

  const identity = (await gitHasIdentity(repoRoot)) ? [] : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@local'];
  const merge = await git(repoRoot, [...identity, 'merge', '--no-ff', '--no-commit', branch]);
  if (!merge.ok) {
    const conflicts = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
    await abortMerge(repoRoot);
    const files = conflicts.stdout.trim().split('\n').filter(Boolean);
    return {
      outcome: 'blocked',
      reason: files.length
        ? `merging "${branch}" into "${base}" conflicts in ${files.join(', ')}`
        : `git merge failed: ${tail(merge.stderr || merge.stdout)}`,
    };
  }

  let checked = false;
  if (input.checkCommand) {
    const check = await runCheck(repoRoot, input.checkCommand);
    if (!check.ok) {
      await abortMerge(repoRoot);
      return { outcome: 'blocked', reason: `the check \`${input.checkCommand}\` failed on the merged tree: ${check.output}` };
    }
    checked = true;
  }

  const commit = await git(repoRoot, [...identity, 'commit', '--no-verify', '--no-edit']);
  if (!commit.ok) {
    await abortMerge(repoRoot);
    return { outcome: 'blocked', reason: `committing the merge failed: ${tail(commit.stderr || commit.stdout)}` };
  }
  const sha = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();

  const push = await pushBase(repoRoot, base);
  if (push.error) return { outcome: 'blocked', reason: `merged locally as ${sha.slice(0, 12)}, but the push failed: ${push.error}`, sha };
  return { outcome: 'merged', sha, base, checked, ...(push.pushedTo ? { pushedTo: push.pushedTo } : {}) };
}

async function abortMerge(repoRoot: string): Promise<void> {
  if (!(await git(repoRoot, ['merge', '--abort'])).ok) await git(repoRoot, ['reset', '--merge']);
}

function runCheck(cwd: string, command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: SELF_MERGE_CHECK_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: tail(`${stdout ?? ''}\n${stderr ?? ''}`) || (err?.message ?? '') }),
    );
  });
}

/**
 * Push the base to its upstream, else to the push remote; a repo with no remote pushes nothing.
 * Skipped under `CEZ_DRY_RUN=1`, which must stay network-free.
 */
async function pushBase(repoRoot: string, base: string): Promise<{ pushedTo?: string; error?: string }> {
  if (process.env.CEZ_DRY_RUN === '1') return {};
  const remote = await git(repoRoot, ['config', '--get', `branch.${base}.remote`]);
  const merge = await git(repoRoot, ['config', '--get', `branch.${base}.merge`]);
  let target: { remote: string; branch: string } | undefined;
  if (remote.ok && remote.stdout.trim() && remote.stdout.trim() !== '.' && merge.ok && merge.stdout.trim().startsWith('refs/heads/')) {
    target = { remote: remote.stdout.trim(), branch: merge.stdout.trim().slice('refs/heads/'.length) };
  } else {
    const { push } = await taskRemotes(repoRoot);
    if (push) target = { remote: push, branch: base };
  }
  if (!target) return {};
  const result = await git(repoRoot, ['push', target.remote, `refs/heads/${base}:refs/heads/${target.branch}`], {
    timeout: PUSH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.ok ? { pushedTo: `${target.remote}/${target.branch}` } : { error: tail(result.stderr || result.stdout) || 'git push failed' };
}
