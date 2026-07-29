import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The staged-only git guard, end to end against the real vendored runtime.
 *
 * The guard used to compare every local head, tag and `reflog --all` entry
 * against the start state, which silently assumed one session owns the whole
 * repository for the duration of a run. cezar breaks that assumption by design:
 * it runs N task worktrees off a single object store while the human keeps
 * working in the main checkout. A run would spend hours on fix rounds and
 * councils and then have `stage` refuse the handoff because someone committed
 * on an unrelated branch — and because reflog selectors are positional, the
 * refusal was permanent, surviving even a `reset --hard` back to the start.
 *
 * These tests pin both halves: unrelated repository churn must not fail a run,
 * and the run's own commits still must.
 */

const RUNTIME = join(
  import.meta.dirname,
  '..',
  '..',
  'vendor',
  'skills',
  'cez-harness',
  'scripts',
  'harness.mjs',
);

/** Commit as a fixed identity so the fixture repo works on bare CI machines. */
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : error
          ? 1
          : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

const git = (args: string[], cwd: string) => run('git', [...GIT_ID, ...args], cwd);
const runtime = (args: string[], cwd: string) => run(process.execPath, [RUNTIME, ...args], cwd);

/** A repo with one linked worktree standing in for a cezar task worktree. */
async function fixture(): Promise<{ repo: string; worktree: string; startState: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'cez-guard-'));
  roots.push(repo);
  await git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '-m', 'base'], repo);
  await git(['worktree', 'add', '-q', '-b', 'cez/run1', '.wt/run1'], repo);
  const worktree = join(repo, '.wt', 'run1');
  const startState = join(repo, 'start-state.json');
  const captured = await runtime(['capture', '--worktree', worktree, '--output', startState], repo);
  expect(captured.code).toBe(0);
  return { repo, worktree, startState };
}

describe('staged-only git guard', () => {
  it('ignores repository churn the run did not cause', async () => {
    const { repo, worktree, startState } = await fixture();

    // Everything that used to fail the handoff, none of it this run's doing:
    // the human commits in their own checkout, a second cezar session claims a
    // worktree and branch, and a release tag lands.
    writeFileSync(join(repo, 'base.txt'), 'base\nhuman edit\n');
    await git(['commit', '-q', '-am', 'human commits on their own branch'], repo);
    await git(['worktree', 'add', '-q', '-b', 'cez/run2', '.wt/run2'], repo);
    await git(['tag', 'v9.9.9'], repo);

    const verified = await runtime(['verify', '--worktree', worktree, '--start-state', startState], repo);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: 'clean', drift: [] });

    // And the handoff itself still goes through.
    writeFileSync(join(worktree, 'feature.txt'), 'the run output\n');
    const paths = join(repo, 'paths.txt');
    writeFileSync(paths, 'feature.txt\n');
    const staged = await runtime(
      ['stage', '--worktree', worktree, '--start-state', startState, '--paths-file', paths],
      repo,
    );
    expect(staged.stderr).toBe('');
    expect(staged.code).toBe(0);
    expect(JSON.parse(staged.stdout)).toMatchObject({
      status: 'ready',
      branch: 'cez/run1',
      stagedPaths: ['feature.txt'],
    });
  });

  /**
   * Regression (run aad28178, 2026-07-28): two hours of green work — councils,
   * three fix rounds, full validation — refused at handoff over trailing
   * whitespace in a spec markdown file and blank lines at EOF. Cosmetic and
   * completeness findings are warnings on the stage result now; the human gate
   * judges them. Only integrity failures still refuse.
   */
  it('stages a whitespace-dirty diff and leftovers with warnings instead of refusing', async () => {
    const { repo, worktree, startState } = await fixture();
    // Trailing whitespace + blank line at EOF — exactly what killed aad28178.
    writeFileSync(join(worktree, 'spec.md'), '**Date**: 2026-07-28 \ntext\n\n', 'utf8');
    // And a leftover the allowlist never mentions.
    writeFileSync(join(worktree, 'scratch-notes.txt'), 'model scratchpad\n', 'utf8');
    const paths = join(repo, 'paths.txt');
    writeFileSync(paths, 'spec.md\n');
    const staged = await runtime(
      ['stage', '--worktree', worktree, '--start-state', startState, '--paths-file', paths],
      repo,
    );
    expect(staged.stderr).toBe('');
    expect(staged.code).toBe(0);
    const result = JSON.parse(staged.stdout) as { status: string; stagedPaths: string[]; warnings?: string[] };
    expect(result.status).toBe('ready');
    expect(result.stagedPaths).toEqual(['spec.md']);
    const warnings = (result.warnings ?? []).join('\n');
    expect(warnings).toContain('whitespace findings');
    expect(warnings).toContain('trailing whitespace');
    expect(warnings).toContain('NOT part of the staged handoff');
    expect(warnings).toContain('scratch-notes.txt');
  });

  /**
   * Predicted, not yet observed: the allowlist is a union across fix rounds, so
   * a file created in round one and deleted in round three is a ghost — listed,
   * absent, untracked — and `git add` used to fail the whole two-hour handoff
   * over a pathspec matching nothing.
   */
  it('drops created-then-deleted allowlist ghosts with a warning instead of refusing', async () => {
    const { repo, worktree, startState } = await fixture();
    writeFileSync(join(worktree, 'feature.txt'), 'kept product\n', 'utf8');
    // scratch.tmp was written by an early round and deleted by a later one —
    // it exists only in the allowlist.
    const paths = join(repo, 'paths.txt');
    writeFileSync(paths, 'feature.txt\nscratch.tmp\n');
    const staged = await runtime(
      ['stage', '--worktree', worktree, '--start-state', startState, '--paths-file', paths],
      repo,
    );
    expect(staged.stderr).toBe('');
    expect(staged.code).toBe(0);
    const result = JSON.parse(staged.stdout) as { status: string; stagedPaths: string[]; warnings?: string[] };
    expect(result.status).toBe('ready');
    expect(result.stagedPaths).toEqual(['feature.txt']);
    expect((result.warnings ?? []).join('\n')).toContain('scratch.tmp');

    // A deleted TRACKED file is not a ghost: staging it stages the deletion.
    const del = await runtime(['verify', '--worktree', worktree, '--start-state', startState], repo);
    expect(del.code).toBe(0); // still clean — deletion staging is covered next
  });

  it('stages the deletion of a tracked file named in the allowlist', async () => {
    const { repo, worktree, startState } = await fixture();
    // base.txt is tracked from the fixture commit; the run deletes it.
    rmSync(join(worktree, 'base.txt'));
    const paths = join(repo, 'paths.txt');
    writeFileSync(paths, 'base.txt\n');
    const staged = await runtime(
      ['stage', '--worktree', worktree, '--start-state', startState, '--paths-file', paths],
      repo,
    );
    expect(staged.stderr).toBe('');
    expect(staged.code).toBe(0);
    const result = JSON.parse(staged.stdout) as { status: string; stagedPaths: string[] };
    expect(result.status).toBe('ready');
    expect(result.stagedPaths).toEqual(['base.txt']);
  });

  it('still refuses a handoff when the run commits on its own branch', async () => {
    const { repo, worktree, startState } = await fixture();
    writeFileSync(join(worktree, 'feature.txt'), 'the run output\n');
    await git(['add', '-A'], worktree);
    await git(['commit', '-q', '-m', 'intermediate commit'], worktree);

    const paths = join(repo, 'paths.txt');
    writeFileSync(paths, 'feature.txt\n');
    const staged = await runtime(
      ['stage', '--worktree', worktree, '--start-state', startState, '--paths-file', paths],
      repo,
    );
    expect(staged.code).not.toBe(0);
    // The reason, not just the fact — an operator has to be able to tell their
    // own commit apart from the run's without reconstructing the timeline.
    expect(staged.stderr).toContain('Git refs or reflogs changed during staged-only run');
    expect(staged.stderr).toContain('this run created or reset a commit');
  });

  it('catches a commit that was reset away again', async () => {
    const { repo, worktree, startState } = await fixture();
    const head = (await git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
    writeFileSync(join(worktree, 'feature.txt'), 'the run output\n');
    await git(['add', '-A'], worktree);
    await git(['commit', '-q', '-m', 'intermediate commit'], worktree);
    await git(['reset', '-q', '--hard', head], worktree);

    // HEAD and the branch ref are back where they started; only the reflog
    // remembers. That is exactly what the reflog half of the snapshot is for.
    const verified = await runtime(['verify', '--worktree', worktree, '--start-state', startState], repo);
    expect(verified.code).toBe(2);
    const result = JSON.parse(verified.stdout) as { status: string; drift: string[] };
    expect(result.status).toBe('drifted');
    expect(result.drift.join('\n')).toContain('intermediate commit');
  });

  it('trusts only HEAD in a start state written by the previous runtime', async () => {
    const { repo, worktree, startState } = await fixture();
    const head = (await git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
    // A run captured before this change and resumed after it: the old snapshot
    // covered the whole repository, so comparing it field-by-field would report
    // drift that never happened and strand the run.
    writeFileSync(
      startState,
      `${JSON.stringify({
        head,
        refs: ['refs/heads/main\tdeadbeef'],
        reflogs: ['deadbeef\tHEAD@{0}'],
      })}\n`,
    );
    const verified = await runtime(['verify', '--worktree', worktree, '--start-state', startState], repo);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: 'clean' });
  });
});
