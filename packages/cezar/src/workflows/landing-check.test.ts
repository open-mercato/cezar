import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger } from '../dispatch/tree-fs.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import {
  detectForeignSubject,
  deriveLandingCandidates,
  gitIn,
  landingCheckStale,
  landingResultOf,
  landingSubjectDigest,
  LANDING_SUBJECT_DIGEST_VERSION,
  materializeLandingSubject,
  verdictFromResults,
  type LandingDerivation,
} from './landing-check.ts';

/**
 * The landing check's ENGINE half (spec `.ai/specs/2026-09-29-landing-check.md`, PR 4): WHAT is
 * checked (the candidate set), WHAT the verdict is about (the materialized tree), and whether
 * that answer has gone stale.
 *
 * Every case runs against a REAL scratch repository. The false positive this file exists to pin
 * — an empty child reading as "already landed" under `--is-ancestor` alone — is a property of
 * git's graph, not of a mock, and a mocked graph would not have caught it: `merge-base
 * --is-ancestor <child> <parent>` answers true for a child whose tip equals its fork point.
 */
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const posix = describe.skipIf(process.platform === 'win32');

let root: string;
let dataDir: string;
let store: RunStore;
let scratch: string[];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout.trim();
}

/** Write a file, commit everything, and return the new HEAD sha. */
async function commit(file: string, text: string, message: string): Promise<string> {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  await git(root, 'add', '-A');
  await git(root, ...GIT_ID, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** A run record the engine could have written, created through the real store. */
function mkRun(options: {
  title: string;
  branch?: string;
  status?: RunRecord['status'];
  kind?: 'implement' | 'review';
  parentId?: string;
  /** The branch the child forked from — `execute()` seeds this from the parent's branch. */
  baseBranch?: string;
  startedAt?: string;
}): RunRecord {
  const record = store.createRun({ title: options.title, workflow: 'task', task: options.title, steps: [] });
  store.updateRun(record.id, {
    status: options.status ?? 'done',
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.parentId
      ? { dispatch: { rootRunId: options.parentId, parentRunId: options.parentId, ...(options.kind ? { kind: options.kind } : {}) } }
      : {}),
  });
  return store.getRun(record.id) as RunRecord;
}

/** Cross a reflog second boundary: git stamps reflog entries with whole seconds, and this file
 *  reads a ref `@{<startedAt>}` — a `startedAt` in the SAME second as a later entry would be
 *  ambiguous. Two of these in one test is the whole cost of the reflog path. */
const nextSecond = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1_100));

/** The check run's own scratch worktree, at the frozen base. */
async function scratchAt(baseSha: string): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), 'cez-landing-wt-')), 'wt');
  await git(root, 'worktree', 'add', '-q', '--detach', path, baseSha);
  scratch.push(path);
  return path;
}

const derive = (parentId: string, parentSha: string, explicit?: string[]): Promise<LandingDerivation> =>
  deriveLandingCandidates({
    dataDir,
    rootRunId: parentId,
    parentId,
    parentSha,
    runs: store.listRuns(),
    git: gitIn(root),
    ...(explicit ? { explicit } : {}),
  });

const candidatesOf = (derivation: LandingDerivation) => {
  expect(derivation.status).toBe('ok');
  return (derivation as Extract<LandingDerivation, { status: 'ok' }>).candidates;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-landing-'));
  dataDir = join(root, '.ai/cezar');
  mkdirSync(dataDir, { recursive: true });
  scratch = [];
  await git(root, 'init', '-q', '-b', 'main');
  await commit('a.txt', 'a\n', 'base');
  store = RunStore.open(dataDir);
});

afterEach(() => {
  store.flush();
  rmSync(root, { recursive: true, force: true });
});

posix('the candidate set', () => {
  it('excludes an empty child (tip == its fork point) instead of reading it as landed, and keeps the ledger order', async () => {
    // The parent's OWN commit is part of the subject's base: an empty child forked off the parent
    // before that commit is an ANCESTOR of the parent tip without being landed.
    const parentSha = await (async () => {
      await git(root, 'checkout', '-q', '-b', 'cez/parent');
      return commit('b.txt', 'parent\n', 'parent work');
    })();
    await git(root, 'checkout', '-q', '-b', 'cez/empty', parentSha); // no commit: tip == fork point
    await git(root, 'checkout', '-q', '-b', 'cez/work', parentSha);
    const childSha = await commit('c.txt', 'child\n', 'child work');
    await git(root, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const empty = mkRun({ title: 'empty', branch: 'cez/empty', parentId: parent.id });
    const work = mkRun({ title: 'work', branch: 'cez/work', parentId: parent.id });
    // Ledger order (chronological) is the SUBJECT order — the reverse of `createdAt` DESC.
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: empty.id, parentRunId: parent.id });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: work.id, parentRunId: parent.id });

    const candidates = candidatesOf(await derive(parent.id, parentSha));
    expect(candidates.order).toBe('ledger');
    expect(candidates.sources).toEqual([{ ref: 'cez/work', sha: childSha }]);
    const reason = new Map(candidates.excluded.map((entry) => [entry.runId, entry.reason]));
    expect(reason.get(empty.id)).toBe('empty');
    expect(reason.get(empty.id)).not.toBe('already-landed');
    expect(candidates.notes.join('\n')).toContain('empty');
  });

  it('tells an already-merged child from an empty one — via the child\'s FORK POINT — and excludes review/failed/non-terminal children', async () => {
    // The parent commits its own work, then dispatches: the fork point both children build on is
    // the parent tip at that instant.
    await git(root, 'checkout', '-q', '-b', 'cez/parent');
    const forkSha = await commit('b.txt', 'parent\n', 'parent work');
    await nextSecond();
    const startedAt = new Date().toISOString(); // when the children's runs started
    await git(root, 'checkout', '-q', '-b', 'cez/merged', forkSha);
    const mergedSha = await commit('m.txt', 'merged\n', 'child work');
    await git(root, 'checkout', '-q', '-b', 'cez/empty2', forkSha); // committed nothing
    await git(root, 'checkout', '-q', '-b', 'cez/reviewed', forkSha);
    await git(root, 'checkout', '-q', '-b', 'cez/failing', forkSha);
    await git(root, 'checkout', '-q', '-b', 'cez/running', forkSha);
    await nextSecond();
    // The parent ACCEPTS the merged child (the `git merge --no-ff` its prompt asks for), moving
    // the parent tip past the child — which is exactly when ancestry alone calls a child landed.
    await git(root, 'checkout', '-q', 'cez/parent');
    await git(root, ...GIT_ID, 'merge', '-q', '--no-ff', '-m', 'merge the child', mergedSha);
    const parentSha = await git(root, 'rev-parse', 'HEAD');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const merged = mkRun({ title: 'merged', branch: 'cez/merged', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    const empty = mkRun({ title: 'empty', branch: 'cez/empty2', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    const review = mkRun({ title: 'review', branch: 'cez/reviewed', kind: 'review', parentId: parent.id, baseBranch: 'cez/parent' });
    const failed = mkRun({ title: 'failed', branch: 'cez/failing', status: 'failed', parentId: parent.id, baseBranch: 'cez/parent' });
    const running = mkRun({ title: 'running', branch: 'cez/running', status: 'running', parentId: parent.id, baseBranch: 'cez/parent' });
    const gone = mkRun({ title: 'gone', branch: 'cez/never-existed', parentId: parent.id, baseBranch: 'cez/parent' });
    for (const child of [merged, empty, review, failed, running, gone]) {
      appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });
    }

    const candidates = candidatesOf(await derive(parent.id, parentSha));
    expect(candidates.sources).toEqual([]);
    const reason = new Map(candidates.excluded.map((entry) => [entry.runId, entry.reason]));
    // The pair that needs the FORK point: both children are ancestors of the parent tip, and only
    // the commit count from where each one STARTED tells them apart.
    expect(reason.get(merged.id)).toBe('already-landed');
    expect(reason.get(empty.id)).toBe('empty');
    expect(reason.get(review.id)).toBe('review');
    expect(reason.get(failed.id)).toBe('failed');
    expect(reason.get(running.id)).toBe('not-terminal');
    expect(reason.get(gone.id)).toBe('missing-ref');
  }, 20_000);

  it('dedupes by sha, records the duplicate, and reports zero eligible sources as an EMPTY BASE-ONLY subject', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'cez/dup', base);
    const dupSha = await commit('d.txt', 'd\n', 'dup');
    await git(root, 'checkout', '-q', 'main');

    const parent = mkRun({ title: 'parent', branch: 'main', status: 'running' });
    const first = mkRun({ title: 'first', branch: 'cez/dup', parentId: parent.id });
    const second = mkRun({ title: 'second', branch: 'cez/dup', parentId: parent.id });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: first.id, parentRunId: parent.id });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: second.id, parentRunId: parent.id });

    const candidates = candidatesOf(await derive(parent.id, base));
    expect(candidates.sources).toEqual([{ ref: 'cez/dup', sha: dupSha }]);
    expect(candidates.excluded).toContainEqual({ runId: second.id, sha: dupSha, reason: 'duplicate' });

    // Zero eligible sources is a VALID subject — the base alone — not an error.
    const emptyParent = mkRun({ title: 'no children', branch: 'main', status: 'running' });
    const none = candidatesOf(await derive(emptyParent.id, base));
    expect(none.sources).toEqual([]);
    expect(none.excluded).toEqual([]);
  });

  it('takes an explicit list verbatim — and refuses when one of its refs has vanished', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'cez/one', base);
    const oneSha = await commit('one.txt', '1\n', 'one');
    await git(root, 'checkout', '-q', 'main');

    const parent = mkRun({ title: 'parent', branch: 'main', status: 'running' });
    const explicit = candidatesOf(await derive(parent.id, base, ['cez/one']));
    expect(explicit.order).toBe('explicit');
    expect(explicit.sources).toEqual([{ ref: 'cez/one', sha: oneSha }]);

    const missing = await derive(parent.id, base, ['cez/one', 'cez/nope']);
    expect(missing).toEqual({
      status: 'could-not-run',
      reason: 'source-missing',
      detail: 'source "cez/nope" does not resolve to a commit',
    });
  });

  it('falls back to createdAt-ascending store order when the tree has no ledger, and says so', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'cez/one', base);
    await commit('one.txt', '1\n', 'one');
    await git(root, 'checkout', '-q', '-b', 'cez/two', base);
    const twoSha = await commit('two.txt', '2\n', 'two');
    await git(root, 'checkout', '-q', 'main');

    const parent = mkRun({ title: 'parent', branch: 'main', status: 'running' });
    const first = mkRun({ title: 'first', branch: 'cez/one', parentId: parent.id });
    const second = mkRun({ title: 'second', branch: 'cez/two', parentId: parent.id });
    expect(second.createdAt >= first.createdAt).toBe(true);

    const candidates = candidatesOf(await derive(parent.id, base));
    expect(candidates.sources.map((source) => source.ref)).toEqual(['cez/one', 'cez/two']);
    expect(candidates.notes.join('\n')).toContain('falling back to store order');
    expect(twoSha).toBe(await git(root, 'rev-parse', 'cez/two'));
  });
});

posix('materialization', () => {
  it('merges by sha with --no-ff and reports the resulting TREE as the identity', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'feat/a', base);
    const shaA = await commit('a-new.txt', 'a\n', 'a');
    await git(root, 'checkout', '-q', '-b', 'feat/b', base);
    const shaB = await commit('b-new.txt', 'b\n', 'b');
    await git(root, 'checkout', '-q', 'main');

    const worktree = await scratchAt(base);
    const result = await materializeLandingSubject({
      worktreePath: worktree,
      baseSha: base,
      sources: [
        { ref: 'feat/a', sha: shaA },
        { ref: 'feat/b', sha: shaB },
      ],
      git: gitIn(worktree),
    });
    expect(result.status).toBe('materialized');
    if (result.status !== 'materialized') return;
    expect(result.merged).toEqual([shaA, shaB]);
    expect(await git(worktree, 'rev-parse', 'HEAD^{tree}')).toBe(result.treeSha);
    expect(result.headSha).not.toBe(shaB); // --no-ff: a merge commit, never a fast-forward
    expect(await git(worktree, 'show', 'HEAD:a-new.txt')).toBe('a');
    expect(await git(worktree, 'show', 'HEAD:b-new.txt')).toBe('b');

    // Identity is the TREE, not HEAD: two merge orders over disjoint files produce different
    // commits and the SAME tree sha — which is what a verdict about "this combination" means.
    const other = await scratchAt(base);
    const reversed = await materializeLandingSubject({
      worktreePath: other,
      baseSha: base,
      sources: [
        { ref: 'feat/b', sha: shaB },
        { ref: 'feat/a', sha: shaA },
      ],
      git: gitIn(other),
    });
    expect(reversed.status).toBe('materialized');
    if (reversed.status !== 'materialized') return;
    expect(reversed.treeSha).toBe(result.treeSha);
    expect(reversed.headSha).not.toBe(result.headSha);
  });

  it('materializes the same subject to the SAME commit on a later run — the digest binds that head', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'feat/same', base);
    const sha = await commit('same.txt', 'same\n', 'same');
    await git(root, 'checkout', '-q', 'main');

    const firstWorktree = await scratchAt(base);
    const first = await materializeLandingSubject({
      worktreePath: firstWorktree,
      baseSha: base,
      sources: [{ ref: 'feat/same', sha }],
      git: gitIn(firstWorktree),
    });
    expect(first.status).toBe('materialized');
    if (first.status !== 'materialized') return;

    // A second later, in another scratch worktree: the same subject. A merge commit carries its
    // identity and its DATE, so without pinning, this HEAD would differ from the first — and the
    // acknowledgement digest binds the materialized head, so a preview's digest could never match
    // the run that acks it.
    await nextSecond();
    const secondWorktree = await scratchAt(base);
    const second = await materializeLandingSubject({
      worktreePath: secondWorktree,
      baseSha: base,
      sources: [{ ref: 'feat/same', sha }],
      git: gitIn(secondWorktree),
    });
    expect(second.status).toBe('materialized');
    if (second.status !== 'materialized') return;
    expect(second.treeSha).toBe(first.treeSha);
    expect(second.headSha).toBe(first.headSha);
  }, 60_000);

  it('stops on a conflict, records the U-files, aborts the merge and runs NOTHING', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await commit('shared.txt', 'base\n', 'shared base');
    const withShared = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'feat/one', withShared);
    const shaOne = await commit('shared.txt', 'one\n', 'one side');
    await git(root, 'checkout', '-q', '-b', 'feat/two', withShared);
    const shaTwo = await commit('shared.txt', 'two\n', 'two side');
    await git(root, 'checkout', '-q', 'main');

    const worktree = await scratchAt(withShared);
    const result = await materializeLandingSubject({
      worktreePath: worktree,
      baseSha: withShared,
      sources: [
        { ref: 'feat/one', sha: shaOne },
        { ref: 'feat/two', sha: shaTwo },
      ],
      git: gitIn(worktree),
    });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.failedSha).toBe(shaTwo);
    expect(result.files).toEqual(['shared.txt']);
    expect(result.merged).toEqual([shaOne]);
    // merge --abort restored the tree: clean index, no MERGE_HEAD, the first source intact.
    expect(await git(worktree, 'status', '--porcelain')).toBe('');
    expect(await git(worktree, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').catch(() => '')).toBe('');
    expect(await git(worktree, 'show', 'HEAD:shared.txt')).toBe('one');
  });

  it('refuses to start on a dirty worktree — a dirty merge would be about a tree nobody can reconstruct', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    const worktree = await scratchAt(base);
    writeFileSync(join(worktree, 'untracked.txt'), 'stray\n');
    const result = await materializeLandingSubject({
      worktreePath: worktree,
      baseSha: base,
      sources: [],
      git: gitIn(worktree),
    });
    expect(result).toEqual({
      status: 'could-not-run',
      reason: 'dirty-worktree',
      detail: 'the check worktree is not clean',
      merged: [],
    });
  });

  it('re-anchors a retried worktree that drifted off the frozen base before merging anything', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'feat/drift', base);
    const driftSha = await commit('drift.txt', 'drift\n', 'drift');
    await git(root, 'checkout', '-q', 'main');
    const worktree = await scratchAt(base);
    await git(worktree, 'checkout', '-q', '--detach', driftSha); // a stale partial from a retry
    const result = await materializeLandingSubject({
      worktreePath: worktree,
      baseSha: base,
      sources: [],
      git: gitIn(worktree),
    });
    expect(result.status).toBe('materialized');
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(await git(worktree, 'ls-files').then((files) => files.split('\n'))).not.toContain('drift.txt');
  });
});

posix('staleness', () => {
  const check = (options: { baseRef: string; baseSha: string; sources: Array<{ ref: string; sha: string }>; treeSha?: string }) => ({
    subject: { ...options },
  });

  it('is false while every ref still resolves to its recorded sha, true once one moves, and never rewritten', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'cez/moving', base);
    const childSha = await commit('m.txt', '1\n', 'one');
    await git(root, 'checkout', '-q', 'main');

    const recorded = check({
      baseRef: 'main',
      baseSha: base,
      sources: [{ ref: 'cez/moving', sha: childSha }],
      treeSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(await landingCheckStale({ landingCheck: recorded, git: gitIn(root) })).toBe(false);

    // The child moved after the check: the verdict is about content that no longer exists there.
    await git(root, 'checkout', '-q', 'cez/moving');
    await commit('m.txt', '2\n', 'two');
    await git(root, 'checkout', '-q', 'main');
    expect(await landingCheckStale({ landingCheck: recorded, git: gitIn(root) })).toBe(true);
    expect(recorded.subject.sources[0]!.sha).toBe(childSha); // the record itself is untouched

    // The BASE moving is staleness too.
    await commit('main.txt', 'moved\n', 'advance main');
    expect(await landingCheckStale({ landingCheck: recorded, git: gitIn(root) })).toBe(true);
  });

  it('is undefined when there is nothing to be stale about, and a deleted ref is not staleness', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    expect(await landingCheckStale({ landingCheck: undefined, git: gitIn(root) })).toBeUndefined();
    expect(
      await landingCheckStale({
        landingCheck: check({ baseRef: 'main', baseSha: base, sources: [] }),
        git: gitIn(root),
      }),
    ).toBeUndefined();

    const deleted = check({
      baseRef: 'main',
      baseSha: base,
      sources: [{ ref: 'cez/gone', sha: 'f'.repeat(40) }],
      treeSha: 'e'.repeat(40),
    });
    // The ref cannot resolve: a deleted branch (or a worktree reclaimed by retention) is not
    // evidence that the CONTENT changed, so it must not read as stale.
    expect(await landingCheckStale({ landingCheck: deleted, git: gitIn(root) })).toBe(false);
  });
});

describe('the verdict vocabulary: only an unbroken run of `passed` is green', () => {
  it('maps every seam outcome onto the record vocabulary with a reason for the non-green ones', () => {
    expect(landingResultOf('passed')).toEqual({ outcome: 'passed' });
    expect(landingResultOf('failed')).toEqual({ outcome: 'failed' });
    expect(landingResultOf('timed-out')).toEqual({ outcome: 'could-not-run', reason: 'timeout' });
    expect(landingResultOf('skipped')).toEqual({ outcome: 'could-not-run', reason: 'dry-run' });
    expect(landingResultOf('cancelled')).toEqual({ outcome: 'could-not-run', reason: 'cancelled' });
    expect(landingResultOf('could-not-run')).toEqual({ outcome: 'could-not-run', reason: 'unsupported-platform' });
  });

  it('is green only for an unbroken run of passed, and names the first non-green reason', () => {
    const entry = (outcome: 'passed' | 'failed' | 'not-run' | 'could-not-run') => ({
      command: 'x',
      exitCode: outcome === 'passed' ? 0 : 1,
      outcome,
      startedAt: 't',
    });
    expect(verdictFromResults([entry('passed'), entry('passed')])).toEqual({ verdict: 'passed' });
    expect(verdictFromResults([entry('passed'), entry('failed')])).toEqual({ verdict: 'failed', reason: 'command-failed' });
    expect(verdictFromResults([entry('passed'), entry('could-not-run')])).toEqual({ verdict: 'could-not-run' });
    expect(verdictFromResults([entry('not-run')])).toEqual({ verdict: 'could-not-run' });
    // Nothing recorded is not a pass either.
    expect(verdictFromResults([])).toEqual({ verdict: 'could-not-run' });
  });
});

describe('the trust model: what makes a subject foreign', () => {
  it('flags a source whose AUTHOR or COMMITTER is outside the local set, naming each identity', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', '-b', 'cez/foreign', base);
    // Author elsewhere, committer local (the `-c` identity is the fixture's own).
    writeFileSync(join(root, 'f1.txt'), 'f1\n');
    await git(root, 'add', '-A');
    await run(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '--author=Other <other@example.com>', '-m', 'authored elsewhere'],
      { cwd: root },
    );
    // Committer elsewhere, author local.
    writeFileSync(join(root, 'f2.txt'), 'f2\n');
    await git(root, 'add', '-A');
    await run(
      'git',
      ['-c', 'user.name=Outsider', '-c', 'user.email=outsider@example.com', 'commit', '-q', '--author=Local <test@local>', '-m', 'committed elsewhere'],
      { cwd: root },
    );
    const sha = await git(root, 'rev-parse', 'HEAD');

    const report = await detectForeignSubject({ git: gitIn(root), baseSha: base, sources: [{ ref: 'cez/foreign', sha }] });
    expect(report.foreign).toBe(true);
    expect(report.authors).toEqual(['Other <other@example.com>', 'Outsider <outsider@example.com>']);
    expect(report.headSha).toBe(sha);
  });

  it('stays LOCAL for the fixture\'s own commits even with NO configured user.email — the base commit identities count', async () => {
    // The machine's global identity is pinned away so "unset" is real: this repository has run
    // no `git config user.email` anywhere, exactly like a fresh container or a CI fixture.
    const saved = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      const base = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'checkout', '-q', '-b', 'cez/local', base);
      const sha = await commit('l.txt', 'l\n', 'local work');
      // `git config --get user.email` really is unset for this check.
      await expect(run('git', ['config', '--get', 'user.email'], { cwd: root })).rejects.toThrow();
      const report = await detectForeignSubject({ git: gitIn(root), baseSha: base, sources: [{ ref: 'cez/local', sha }] });
      expect(report.foreign).toBe(false);
      expect(report.authors).toEqual([]);

      // ...and the same fixture's third-party commit IS foreign under the same pinned config.
      writeFileSync(join(root, 'x.txt'), 'x\n');
      await git(root, 'add', '-A');
      await run('git', ['-c', 'user.name=Outsider', '-c', 'user.email=outsider@example.com', 'commit', '-q', '-m', 'elsewhere'], { cwd: root });
      const foreignSha = await git(root, 'rev-parse', 'HEAD');
      const foreign = await detectForeignSubject({ git: gitIn(root), baseSha: sha, sources: [{ ref: 'cez/local', sha: foreignSha }] });
      expect(foreign.foreign).toBe(true);
      expect(foreign.authors).toEqual(['Outsider <outsider@example.com>']);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('the acknowledgement digest', () => {
  const input = {
    baseRef: 'cez/parent',
    baseSha: 'a'.repeat(40),
    sources: [{ ref: 'cez/child', sha: 'b'.repeat(40) }],
    treeSha: 'c'.repeat(40),
    headSha: 'e'.repeat(40),
    commandsDigest: 'd'.repeat(64),
    installArgv: ['npm', 'install'],
  };

  it('is a versioned canonical sha256: stable for the same subject, moved by every semantic input', () => {
    const first = landingSubjectDigest(input);
    expect(first.version).toBe(LANDING_SUBJECT_DIGEST_VERSION);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(first.canonical)).toEqual({
      version: LANDING_SUBJECT_DIGEST_VERSION,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      sources: [{ ref: 'cez/child', sha: 'b'.repeat(40) }],
      treeSha: input.treeSha,
      headSha: input.headSha,
      commandsDigest: input.commandsDigest,
      installArgv: ['npm', 'install'],
    });
    // Same subject, recomputed (a second run over the same shas) — same digest.
    expect(landingSubjectDigest({ ...input, sources: [{ ...input.sources[0]! }] }).digest).toBe(first.digest);

    const moved = (patch: Partial<typeof input>): string => landingSubjectDigest({ ...input, ...patch }).digest;
    expect(moved({ baseRef: 'cez/other' })).not.toBe(first.digest);
    expect(moved({ baseSha: '1'.repeat(40) })).not.toBe(first.digest);
    expect(moved({ treeSha: '2'.repeat(40) })).not.toBe(first.digest);
    expect(moved({ headSha: '6'.repeat(40) })).not.toBe(first.digest);
    expect(moved({ commandsDigest: '3'.repeat(64) })).not.toBe(first.digest);
    expect(moved({ sources: [{ ref: 'cez/child', sha: '4'.repeat(40) }] })).not.toBe(first.digest);
    expect(moved({ sources: [{ ref: 'cez/renamed', sha: input.sources[0]!.sha }] })).not.toBe(first.digest);
    expect(moved({ installArgv: ['npm', 'ci'] })).not.toBe(first.digest);
    expect(moved({ installArgv: [] })).not.toBe(first.digest);
  });
});

describe('the landingCheck record field', () => {
  it('round-trips through the store, and an unparseable field drops the FIELD, never the run', () => {
    const subject = {
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      sources: [{ ref: 'cez/kid', sha: 'b'.repeat(40) }],
      order: 'ledger' as const,
    };
    const keeper = store.createRun({ title: 'keeper', workflow: 'task', task: 'k', steps: [] });
    store.updateRun(keeper.id, {
      landingCheck: {
        ofRunId: 'parent',
        subject,
        // The acknowledgement rides on the record so the check run that materializes the subject
        // later can compare it — the store PARSES the record, so a key the contract does not
        // declare is silently stripped (which is why this assertion exists).
        request: { commands: ['npm test'], acknowledge: { digest: 'e'.repeat(64) } },
        ack: { digest: 'e'.repeat(64), at: 't' },
        verdict: 'passed',
        results: [{ command: 'npm test', exitCode: 0, outcome: 'passed', startedAt: 't' }],
      },
    });
    const drifted = store.createRun({ title: 'drifted', workflow: 'task', task: 'd', steps: [] });
    store.updateRun(drifted.id, {
      landingCheck: { ofRunId: 'parent', subject, verdict: 'passed' },
    });
    store.flush();

    // A verdict outside the enum — what a future engine writing a sixth state would look like on
    // an older binary. The record must LOSE the field and keep the run, because `runs.json` is
    // parsed as ONE array: a record that fails to parse would evict the whole index.
    const path = join(dataDir, 'runs.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    const target = raw.find((record) => record.id === drifted.id);
    expect(target).toBeDefined();
    (target!.landingCheck as Record<string, unknown>).verdict = 'a-state-that-does-not-exist';
    writeFileSync(path, JSON.stringify(raw));

    const reopened = RunStore.open(dataDir);
    expect(reopened.listRuns().map((record) => record.id)).toContain(keeper.id);
    expect(reopened.getRun(keeper.id)?.landingCheck?.verdict).toBe('passed');
    expect(reopened.getRun(keeper.id)?.landingCheck?.results?.[0]?.outcome).toBe('passed');
    expect(reopened.getRun(keeper.id)?.landingCheck?.request?.acknowledge?.digest).toBe('e'.repeat(64));
    expect(reopened.getRun(keeper.id)?.landingCheck?.ack?.digest).toBe('e'.repeat(64));
    expect(reopened.getRun(drifted.id)).toBeDefined();
    expect(reopened.getRun(drifted.id)?.landingCheck).toBeUndefined();
  });
});
