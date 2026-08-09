import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  branchFor,
  createWorktree,
  parseShortstat,
  resolveBaseRef,
  worktreeShortstat,
  worktreeSizeBytes,
} from './git-worktree.ts';

const run = promisify(execFile);

/** Commit as a fixed identity so the fixture repo works on bare CI machines. */
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const worktreeRoots: string[] = [];

async function fixtureRepo(prefix: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  worktreeRoots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

afterEach(() => {
  // `maxRetries` is the point: git detaches background maintenance after a clone or a
  // commit, so a fixture's `.git` can still gain files while the removal walks it, and the
  // rmdir fails with ENOTEMPTY. It is load-dependent — this teardown reddened CI while
  // passing locally every time. Retrying lets the stray writer finish instead.
  for (const root of worktreeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('parseShortstat', () => {
  const cases: Array<{ name: string; input: string; expected: { adds: number; dels: number; files: number } }> = [
    {
      name: 'full form',
      input: ' 3 files changed, 10 insertions(+), 2 deletions(-)',
      expected: { adds: 10, dels: 2, files: 3 },
    },
    {
      name: 'singulars',
      input: ' 1 file changed, 1 insertion(+), 1 deletion(-)',
      expected: { adds: 1, dels: 1, files: 1 },
    },
    {
      name: 'insertions only',
      input: ' 2 files changed, 7 insertions(+)',
      expected: { adds: 7, dels: 0, files: 2 },
    },
    {
      name: 'deletions only',
      input: ' 1 file changed, 5 deletions(-)',
      expected: { adds: 0, dels: 5, files: 1 },
    },
    {
      name: 'empty diff prints nothing at all',
      input: '',
      expected: { adds: 0, dels: 0, files: 0 },
    },
    {
      name: 'trailing newline (raw git stdout)',
      input: ' 4 files changed, 12 insertions(+), 3 deletions(-)\n',
      expected: { adds: 12, dels: 3, files: 4 },
    },
    {
      // Mode-only / rename-only changes: files changed without either counter.
      name: 'files changed with no line counters',
      input: ' 1 file changed, 0 insertions(+), 0 deletions(-)',
      expected: { adds: 0, dels: 0, files: 1 },
    },
  ];

  // Note on locales: `--shortstat` is porcelain whose wording git never
  // localizes, so matching the English words is stable by contract.
  it.each(cases)('$name', ({ input, expected }) => {
    expect(parseShortstat(input)).toEqual(expected);
  });
});

describe('worktreeSizeBytes (#483)', () => {
  it('returns a positive byte count for a real directory', async () => {
    const repo = await fixtureRepo('cez-du-');
    const size = await worktreeSizeBytes(repo);
    expect(size).not.toBeNull();
    expect(size!).toBeGreaterThan(0);
  });

  it('degrades to null for a path that does not exist (du errors)', async () => {
    expect(await worktreeSizeBytes(join(tmpdir(), 'cez-du-nope-does-not-exist-12345'))).toBeNull();
  });
});

describe('createWorktree recovery (real git)', () => {
  it('is idempotent when the task worktree is already registered', async () => {
    const repo = await fixtureRepo('cez-worktree-idempotent-');
    const runId = '11111111-1111-4111-8111-111111111111';

    const first = await createWorktree(repo, runId, 'main');
    const second = await createWorktree(repo, runId, 'main');

    expect(second).toEqual(first);
    expect(first.baseBranch).toBe('main');
    const listed = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
    expect(listed.stdout.match(new RegExp(`branch refs/heads/${branchFor(runId)}`, 'g'))).toHaveLength(1);
  });

  it('reattaches a surviving task branch after its worktree directory is deleted', async () => {
    const repo = await fixtureRepo('cez-worktree-reattach-');
    const runId = '22222222-2222-4222-8222-222222222222';
    const first = await createWorktree(repo, runId, 'main');
    writeFileSync(join(first.path, 'progress.txt'), 'preserved\n');
    await run('git', ['add', '-A'], { cwd: first.path });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'task progress'], { cwd: first.path });

    rmSync(first.path, { recursive: true, force: true });
    await run('git', ['worktree', 'prune'], { cwd: repo });

    const recovered = await createWorktree(repo, runId, 'main');
    const log = await run('git', ['log', '-1', '--format=%s'], { cwd: recovered.path });
    expect(recovered.path).toBe(first.path);
    expect(log.stdout.trim()).toBe('task progress');
    expect(() => writeFileSync(join(recovered.path, 'still-usable.txt'), 'yes\n')).not.toThrow();
  });

  it('preserves an unregistered non-empty managed path instead of deleting it', async () => {
    const repo = await fixtureRepo('cez-worktree-preserve-');
    const runId = '33333333-3333-4333-8333-333333333333';
    const path = join(repo, '.ai/cezar/worktrees', runId);
    const marker = join(path, 'uncommitted.txt');
    mkdirSync(path, { recursive: true });
    writeFileSync(marker, 'do not delete\n');

    await expect(createWorktree(repo, runId, 'main')).rejects.toThrow(
      'managed worktree path already exists and could not be repaired',
    );
    expect(readFileSync(marker, 'utf8')).toBe('do not delete\n');
  });
});

describe('worktreeShortstat (real git)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-shortstat-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repo });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
    await run('git', ['checkout', '-q', '-b', 'work'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('counts modified + untracked (intent-to-add) files against the base', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n'); // 1 add, 1 del
    writeFileSync(join(repo, 'new.txt'), 'x\ny\n'); // 2 adds, untracked
    const stat = await worktreeShortstat(repo, 'main');
    expect(stat).toEqual({ adds: 3, dels: 1, files: 2 });
  });

  it('answers all zeros for a clean tree, not null', async () => {
    await run('git', ['checkout', '-q', '--', '.'], { cwd: repo });
    rmSync(join(repo, 'new.txt'), { force: true });
    // Drop the intent-to-add entry the previous test staged.
    await run('git', ['reset', '-q'], { cwd: repo });
    const stat = await worktreeShortstat(repo, 'main');
    expect(stat).toEqual({ adds: 0, dels: 0, files: 0 });
  });

  it('answers null when the path is not a git worktree', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-notgit-'));
    try {
      expect(await worktreeShortstat(plain, 'main')).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('counts only the task\'s own changes after the base is merged back in', async () => {
    // Regression: anchoring to a moving base *name* (via merge-base) must stay
    // correct when the task syncs with its base — the routine merge that a
    // pinned fork commit would have inflated by swallowing every upstream commit.
    const r = mkdtempSync(join(tmpdir(), 'cez-mergeback-'));
    worktreeRoots.push(r);
    await run('git', ['init', '-q', '-b', 'main'], { cwd: r });
    writeFileSync(join(r, 'f.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: r });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'c0'], { cwd: r });
    await run('git', ['checkout', '-q', '-b', 'task'], { cwd: r });
    writeFileSync(join(r, 'task.txt'), 'task-change\n'); // the one real change
    await run('git', ['add', '-A'], { cwd: r });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'task work'], { cwd: r });
    // Base moves far ahead, then the task merges it back in (conflict-free).
    await run('git', ['checkout', '-q', 'main'], { cwd: r });
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(r, 'big.txt'), `${'upstream\n'.repeat(i + 1)}`);
      await run('git', ['add', '-A'], { cwd: r });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', `upstream ${i}`], { cwd: r });
    }
    await run('git', ['checkout', '-q', 'task'], { cwd: r });
    await run('git', [...GIT_ID, 'merge', '-q', '--no-edit', 'main'], { cwd: r });

    // Only task.txt (1 add) — NOT the merged-in upstream lines.
    expect(await worktreeShortstat(r, 'main')).toEqual({ adds: 1, dels: 0, files: 1 });
  });

  /**
   * #751: a review/QA task checks the branch under review out into its own
   * worktree, which repoints HEAD off the task's branch. Anchoring at the
   * merge-base then attributes that whole branch's diff to a task that
   * committed nothing — the measured symptom was `+22505 −2628 / 774 files`
   * on a task whose own branch sat exactly on `main`.
   */
  describe('repointed HEAD (#751)', () => {
    /** `main` + a task branch at main's tip + an `other` branch far ahead. */
    async function repoWithForeignBranch(): Promise<string> {
      const r = mkdtempSync(join(tmpdir(), 'cez-repointed-'));
      worktreeRoots.push(r);
      await run('git', ['init', '-q', '-b', 'main'], { cwd: r });
      writeFileSync(join(r, 'f.txt'), 'base\n');
      await run('git', ['add', '-A'], { cwd: r });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'c0'], { cwd: r });
      // The task's own branch: created off main and never committed to.
      await run('git', ['branch', 'cez/x'], { cwd: r });
      // Somebody else's branch, with real commits on it.
      await run('git', ['checkout', '-q', '-b', 'other'], { cwd: r });
      writeFileSync(join(r, 'theirs.txt'), 'a\nb\nc\nd\ne\n'); // 5 adds that are NOT this task's
      await run('git', ['add', '-A'], { cwd: r });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'their work'], { cwd: r });
      return r;
    }

    it('counts only uncommitted work when HEAD sits on someone else\'s branch', async () => {
      const r = await repoWithForeignBranch();
      writeFileSync(join(r, 'mine.txt'), 'z\n'); // the 1 line this task actually produced

      expect(await worktreeShortstat(r, 'main', { taskBranch: 'cez/x' })).toEqual({
        adds: 1,
        dels: 0,
        files: 1,
        repointed: true,
      });
    });

    it('reports the foreign branch\'s whole diff without the guard — the bug being fixed', async () => {
      const r = await repoWithForeignBranch();
      writeFileSync(join(r, 'mine.txt'), 'z\n');

      // No `taskBranch` → nothing to compare HEAD against → the pre-#751 answer,
      // which swallows `other`'s 5 committed lines. Pinned so a future refactor
      // cannot quietly re-narrow the no-taskBranch path (the main working tree
      // has no task branch and must keep the whole-branch anchor).
      expect(await worktreeShortstat(r, 'main')).toEqual({ adds: 6, dels: 0, files: 2 });
    });

    it('leaves the normal on-task-branch case exactly as it was — no `repointed` key', async () => {
      const r = await repoWithForeignBranch();
      await run('git', ['checkout', '-q', 'cez/x'], { cwd: r });
      writeFileSync(join(r, 'mine.txt'), 'z\n');

      const stat = await worktreeShortstat(r, 'main', { taskBranch: 'cez/x' });
      expect(stat).toEqual({ adds: 1, dels: 0, files: 1 });
      expect(stat).not.toHaveProperty('repointed');
    });

    it('narrows a detached HEAD too — it is not the task branch either', async () => {
      const r = await repoWithForeignBranch();
      await run('git', ['checkout', '-q', '--detach'], { cwd: r });
      writeFileSync(join(r, 'mine.txt'), 'z\n');

      expect(await worktreeShortstat(r, 'main', { taskBranch: 'cez/x' })).toEqual({
        adds: 1,
        dels: 0,
        files: 1,
        repointed: true,
      });
    });

    it('answers an honest all-zeros (still flagged) when a repointed task changed nothing', async () => {
      const r = await repoWithForeignBranch();

      expect(await worktreeShortstat(r, 'main', { taskBranch: 'cez/x' })).toEqual({
        adds: 0,
        dels: 0,
        files: 0,
        repointed: true,
      });
    });

    /**
     * The other half of #751: `HEAD` alone is right for a review that committed
     * nothing and wrong for the far more common run whose agent opened a named
     * branch and committed real work on it — those reported `+0 −0`. With the
     * run's start time the anchor becomes the branch as the run FOUND it, which
     * answers both cases. Reflog entries take their timestamps from the
     * committer ident, so the fixtures below date the pre-run history explicitly
     * instead of sleeping.
     */
    describe('with the run start to read the branch at', () => {
      const LONG_AGO = '2026-01-01T00:00:00Z';
      const RUN_STARTED_AT = '2026-06-01T00:00:00Z';
      /** Reflog entries take their timestamp from the committer ident, so dating a
       *  command's environment is how a fixture puts history *before* the run. */
      const dated = (iso: string, cwd: string) => ({
        cwd,
        env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
      });

      /** `main`, an untouched `cez/x`, and a foreign branch whose commits predate the run. */
      async function repoWithOlderForeignBranch(): Promise<string> {
        const r = mkdtempSync(join(tmpdir(), 'cez-baseline-'));
        worktreeRoots.push(r);
        const old = dated(LONG_AGO, r);
        await run('git', ['init', '-q', '-b', 'main'], { cwd: r });
        writeFileSync(join(r, 'f.txt'), 'base\n');
        await run('git', ['add', '-A'], { cwd: r });
        await run('git', [...GIT_ID, 'commit', '-q', '-m', 'c0'], old);
        await run('git', ['branch', 'cez/x'], old);
        await run('git', ['checkout', '-q', '-b', 'other'], old);
        writeFileSync(join(r, 'theirs.txt'), 'a\nb\nc\nd\ne\n'); // 5 lines that predate the run
        await run('git', ['add', '-A'], { cwd: r });
        await run('git', [...GIT_ID, 'commit', '-q', '-m', 'their work'], old);
        return r;
      }

      it('counts what the run committed on a foreign branch, never what was already there', async () => {
        const r = await repoWithOlderForeignBranch();
        writeFileSync(join(r, 'mine.txt'), 'z\n');
        await run('git', ['add', '-A'], { cwd: r });
        await run('git', [...GIT_ID, 'commit', '-q', '-m', 'the run\'s own fix'], { cwd: r });
        writeFileSync(join(r, 'wip.txt'), 'w\n'); // uncommitted, also this run's

        expect(
          await worktreeShortstat(r, 'main', { taskBranch: 'cez/x', runStartedAt: RUN_STARTED_AT }),
        ).toEqual({ adds: 2, dels: 0, files: 2, repointed: true });
      });

      it('still reports zero for a review run that only read the branch', async () => {
        const r = await repoWithOlderForeignBranch();

        expect(
          await worktreeShortstat(r, 'main', { taskBranch: 'cez/x', runStartedAt: RUN_STARTED_AT }),
        ).toEqual({ adds: 0, dels: 0, files: 0, repointed: true });
      });

      it('counts the committed work on a branch the agent opened during the run', async () => {
        // The `+0 −0` case: every om-* skill commits on its own `feat/…` branch, so
        // the uncommitted-only anchor reported nothing for the run's real output.
        const r = await repoWithOlderForeignBranch();
        await run('git', ['checkout', '-q', 'main'], { cwd: r });
        await run('git', ['checkout', '-q', '-b', 'feat/mine'], { cwd: r });
        writeFileSync(join(r, 'mine.txt'), 'a\nb\nc\n');
        await run('git', ['add', '-A'], { cwd: r });
        await run('git', [...GIT_ID, 'commit', '-q', '-m', 'the run\'s work'], { cwd: r });

        expect(
          await worktreeShortstat(r, 'main', { taskBranch: 'cez/x', runStartedAt: RUN_STARTED_AT }),
        ).toEqual({ adds: 3, dels: 0, files: 1, repointed: true });
      });

      it('prefers the merge-base when the run merged the base into the branch it checked out', async () => {
        // Then the pre-run tip is behind everything that merge dragged in, and anchoring
        // there would re-attribute the whole upstream delta to this task.
        const r = await repoWithOlderForeignBranch();
        await run('git', ['checkout', '-q', 'main'], { cwd: r });
        for (let i = 0; i < 3; i += 1) {
          writeFileSync(join(r, 'big.txt'), 'upstream\n'.repeat(i + 1));
          await run('git', ['add', '-A'], { cwd: r });
          await run('git', [...GIT_ID, 'commit', '-q', '-m', `upstream ${i}`], { cwd: r });
        }
        await run('git', ['checkout', '-q', 'other'], { cwd: r });
        await run('git', [...GIT_ID, 'merge', '-q', '--no-edit', 'main'], { cwd: r });
        writeFileSync(join(r, 'mine.txt'), 'z\n');

        // The pre-run tip now trails the 3 merged-in upstream lines, so the merge-base
        // is the tighter anchor: `theirs.txt` (5, written before the run) drops out.
        expect(
          await worktreeShortstat(r, 'main', { taskBranch: 'cez/x', runStartedAt: RUN_STARTED_AT }),
        ).toEqual({ adds: 4, dels: 0, files: 2, repointed: true });
      });
    });
  });

  /**
   * The stale-local-base trap: agents `git fetch`, they never pull, so a repo the
   * user does not pull either keeps a `main` that drifts arbitrarily far behind
   * `origin/main`. The merge-base then collapses onto that stale tip and the
   * upstream history the task forked from counts as its own — a one-line change
   * measured five figures.
   */
  describe('a stale local base ref (real git)', () => {
    async function workRepoBehindOrigin(): Promise<string> {
      const origin = mkdtempSync(join(tmpdir(), 'cez-stale-origin-'));
      worktreeRoots.push(origin);
      await run('git', ['init', '-q', '-b', 'main'], { cwd: origin });
      writeFileSync(join(origin, 'f.txt'), 'base\n');
      await run('git', ['add', '-A'], { cwd: origin });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'c0'], { cwd: origin });

      const work = mkdtempSync(join(tmpdir(), 'cez-stale-work-'));
      worktreeRoots.push(work);
      // `-c gc.auto=0` is `clone --config`: it lands in the new repo, so neither the clone
      // nor any later commit in it detaches a background gc that would still be writing
      // into `.git` when the afterEach above removes the fixture.
      await run('git', ['clone', '-q', '-c', 'gc.auto=0', origin, work], { cwd: tmpdir() });

      // Origin moves on by a lot; the work repo only ever fetches, so `origin/main`
      // advances while the local `main` ref stays where the clone left it.
      for (let i = 0; i < 4; i += 1) {
        writeFileSync(join(origin, 'upstream.txt'), 'upstream\n'.repeat(i + 1));
        await run('git', ['add', '-A'], { cwd: origin });
        await run('git', [...GIT_ID, 'commit', '-q', '-m', `upstream ${i}`], { cwd: origin });
      }
      await run('git', ['fetch', '-q', 'origin'], { cwd: work });
      return work;
    }

    it('measures against origin/<base>, not the local ref the task never pulled', async () => {
      const work = await workRepoBehindOrigin();
      // The task forks from the freshest base — exactly what `resolveBaseRef` does at
      // worktree-creation time — and commits one line.
      await run('git', ['checkout', '-q', '-b', 'cez/x', 'origin/main'], { cwd: work });
      writeFileSync(join(work, 'mine.txt'), 'z\n');
      await run('git', ['add', '-A'], { cwd: work });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'the task'], { cwd: work });

      // 1 line — not the 4 upstream lines the stale `main` would have swallowed.
      expect(await worktreeShortstat(work, 'main', { taskBranch: 'cez/x' })).toEqual({
        adds: 1,
        dels: 0,
        files: 1,
      });
    });

    it('keeps counting unpushed base commits as base, not as the task\'s work', async () => {
      const work = await workRepoBehindOrigin();
      // A local base that is AHEAD of origin is not stale — it is the better answer.
      await run('git', ['checkout', '-q', 'main'], { cwd: work });
      await run('git', ['merge', '-q', 'origin/main'], { cwd: work });
      writeFileSync(join(work, 'unpushed.txt'), 'local base work\n');
      await run('git', ['add', '-A'], { cwd: work });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'unpushed base commit'], { cwd: work });
      await run('git', ['checkout', '-q', '-b', 'cez/x'], { cwd: work });
      writeFileSync(join(work, 'mine.txt'), 'z\n');

      expect(await worktreeShortstat(work, 'main', { taskBranch: 'cez/x' })).toEqual({
        adds: 1,
        dels: 0,
        files: 1,
      });
    });
  });
});

describe('resolveBaseRef (real git)', () => {
  /** A work repo cloned from an `origin` that carries a `develop` branch, so
   *  both a local `develop` and `origin/develop` remote-tracking ref exist. */
  async function repoWithOrigin(): Promise<string> {
    const origin = mkdtempSync(join(tmpdir(), 'cez-origin-'));
    worktreeRoots.push(origin);
    await run('git', ['init', '-q', '-b', 'main'], { cwd: origin });
    writeFileSync(join(origin, 'a.txt'), '1\n');
    await run('git', ['add', '-A'], { cwd: origin });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'c1'], { cwd: origin });
    await run('git', ['checkout', '-q', '-b', 'develop'], { cwd: origin });
    for (const n of ['2', '3']) {
      writeFileSync(join(origin, 'a.txt'), `${n}\n`);
      await run('git', [...GIT_ID, 'commit', '-q', '-am', `c${n}`], { cwd: origin });
    }
    const work = mkdtempSync(join(tmpdir(), 'cez-work-'));
    worktreeRoots.push(work);
    // `-c gc.auto=0` is `clone --config`: it lands in the new repo, so neither the clone
    // nor any later commit in it detaches a background gc that would still be writing
    // into `.git` when the afterEach above removes the fixture.
    await run('git', ['clone', '-q', '-c', 'gc.auto=0', origin, work], { cwd: tmpdir() });
    // Materialize a local `develop` tracking origin/develop.
    await run('git', ['checkout', '-q', 'develop'], { cwd: work });
    await run('git', ['checkout', '-q', 'main'], { cwd: work });
    return work;
  }

  it('returns the local branch when it is up to date with origin', async () => {
    const work = await repoWithOrigin();
    expect(await resolveBaseRef(work, 'develop')).toBe('develop');
  });

  it('prefers origin/<base> when the local branch is STALE (behind origin)', async () => {
    const work = await repoWithOrigin();
    // Rewind local develop one commit behind origin/develop — the phantom-diff trap.
    await run('git', ['branch', '-f', 'develop', 'develop~1'], { cwd: work });
    expect(await resolveBaseRef(work, 'develop')).toBe('origin/develop');
  });

  it('keeps the local branch when it is AHEAD (unpushed base commits)', async () => {
    const work = await repoWithOrigin();
    await run('git', ['checkout', '-q', 'develop'], { cwd: work });
    writeFileSync(join(work, 'a.txt'), 'local-ahead\n');
    await run('git', [...GIT_ID, 'commit', '-q', '-am', 'local only'], { cwd: work });
    await run('git', ['checkout', '-q', 'main'], { cwd: work });
    expect(await resolveBaseRef(work, 'develop')).toBe('develop');
  });

  it('prefers origin/<base> when local and origin have DIVERGED', async () => {
    const work = await repoWithOrigin();
    // Rewrite local develop onto an unrelated commit → neither is an ancestor.
    await run('git', ['branch', '-f', 'develop', 'main'], { cwd: work });
    expect(await resolveBaseRef(work, 'develop')).toBe('origin/develop');
  });

  it('falls back to origin/<base> for a branch that exists only on origin', async () => {
    const work = await repoWithOrigin();
    // No local develop was materialized here; delete it to be sure.
    await run('git', ['branch', '-D', 'develop'], { cwd: work }).catch(() => undefined);
    expect(await resolveBaseRef(work, 'develop')).toBe('origin/develop');
  });

  it('returns the local name for a local-only branch, and null when neither exists', async () => {
    const repo = await fixtureRepo('cez-resolve-localonly-');
    expect(await resolveBaseRef(repo, 'main')).toBe('main');
    expect(await resolveBaseRef(repo, 'nope-no-such-branch')).toBeNull();
  });

  it('refuses an option-like base ref', async () => {
    const repo = await fixtureRepo('cez-resolve-dashguard-');
    expect(await resolveBaseRef(repo, '--upload-pack=evil')).toBeNull();
  });
});
