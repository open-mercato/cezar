import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessPublishPin } from '@open-mercato/cezar-contract';
import { pinnedGitEnv } from '../git-pin.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...pinnedGitEnv(cwd) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  }).trimEnd();
}

export function captureHarnessHandoff(cwd: string): HarnessPublishPin {
  const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir']);
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((name) => existsSync(join(gitDir, name)))) {
    throw new Error('a Git operation is in progress');
  }
  const status = git(cwd, ['status', '--porcelain=v1', '--no-renames', '--untracked-files=all', '--ignore-submodules=none']);
  if (status.split('\n').some((line) => line.length > 0 && line[1] !== ' ')) {
    throw new Error('the worktree contains unstaged or untracked changes');
  }
  const ref = git(cwd, ['symbolic-ref', 'HEAD']);
  if (!ref.startsWith('refs/heads/')) throw new Error('the task branch is not checked out');
  return {
    branch: ref.slice('refs/heads/'.length),
    head: git(cwd, ['rev-parse', '--verify', 'HEAD']),
    tree: git(cwd, ['write-tree']),
  };
}

export function verifyHarnessHandoff(cwd: string, pin: HarnessPublishPin): { state: 'staged' | 'committed'; head: string } {
  const current = captureHarnessHandoff(cwd);
  if (current.branch !== pin.branch || current.tree !== pin.tree) throw new Error('the branch or staged tree changed');
  if (current.head === pin.head) return { state: 'staged', head: current.head };
  // An interrupted publish may have created the exact reviewed commit before returning.
  if (git(cwd, ['show', '-s', '--format=%P%n%T', current.head]) === `${pin.head}\n${pin.tree}`) {
    return { state: 'committed', head: current.head };
  }
  throw new Error('HEAD changed outside the reviewed handoff');
}

export function commitHarnessHandoff(
  cwd: string,
  pin: HarnessPublishPin,
  current: ReturnType<typeof verifyHarnessHandoff>,
  message: string,
): string {
  if (current.state === 'committed') return current.head;
  let identity: string[] = [];
  try {
    git(cwd, ['var', 'GIT_AUTHOR_IDENT']);
    git(cwd, ['var', 'GIT_COMMITTER_IDENT']);
  } catch {
    identity = ['-c', 'user.name=cezar', '-c', 'user.email=cezar@local'];
  }
  // Use the pinned tree directly and compare-and-swap the task ref. A later index edit or
  // branch movement cannot alter what this commit contains or overwrite a different tip.
  let sha: string;
  try {
    const sign = git(cwd, ['config', '--type=bool', '--default=false', '--get', 'commit.gpgSign']) === 'true';
    sha = git(cwd, [...identity, 'commit-tree', ...(sign ? ['-S'] : []), pin.tree, '-p', pin.head, '-m', message]);
  } catch {
    throw new Error('Could not create the reviewed commit. Check Git identity and signing settings before retrying.');
  }
  try {
    git(cwd, ['update-ref', '-m', 'cezar: commit reviewed handoff', `refs/heads/${pin.branch}`, sha, pin.head]);
  } catch {
    throw new Error('Could not advance the reviewed task branch. Check the branch and retry.');
  }
  return sha;
}
