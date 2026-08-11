import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import {
  FILE_CONTENT_CAP,
  assemblePayload,
  collectChanges,
  collectRunCommits,
  commitAll,
  createOrSwitchBranch,
  imageMimeType,
  isOsOpenableImage,
  patchByPath,
  pushCurrentBranch,
  readWorktreePath,
  splitPatch,
  type ChangesPayload,
} from './git-changes.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * Session git API (redesign R5 Step 1.2 — spec §"Git/session API additions"):
 * structured /changes, /files browsing, git/commit and git/push — against
 * real fixture git repos in tmp dirs. Every predictable git failure must be
 * a 409 with a human reason (never HTML, never a 500); 404 only for unknown
 * run ids. The text-blob /diff endpoint is a protected surface and untested
 * here on purpose — nothing in this step touches it.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** `g`, with the clock moved: reflog entries take their timestamp from the committer
 *  ident, so this is how a fixture puts branch history *before* a run started. */
function gAt(dir: string, iso: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}

/** Fresh repo with identity configured and one initial commit on `main`. */
function initRepo(dir: string): void {
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@cezar.local');
  g(dir, 'config', 'user.name', 'cezar-test');
  g(dir, 'config', 'commit.gpgsign', 'false');
}

describe('collectChanges — structured diff vs base', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-changes-'));
    initRepo(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports modified, added, deleted, renamed and binary files with counts and patches', async () => {
    writeFileSync(join(dir, 'mod.txt'), 'line one\nline two\n');
    writeFileSync(join(dir, 'del.txt'), 'goes away\n');
    writeFileSync(join(dir, 'ren.txt'), 'stable content that stays identical across the rename\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    g(dir, 'checkout', '-b', 'task');

    // Committed rename + binary change…
    g(dir, 'mv', 'ren.txt', 'renamed.txt');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 1]));
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'rename + binary');
    // …plus uncommitted edits and an untracked file — all must show up.
    writeFileSync(join(dir, 'mod.txt'), 'line one\nline two changed\nline three\n');
    rmSync(join(dir, 'del.txt'));
    writeFileSync(join(dir, 'new.txt'), 'brand new\n');

    const result = await collectChanges(dir, 'main');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = new Map(result.changes.files.map((f) => [f.path, f]));

    expect(byPath.get('new.txt')).toMatchObject({ status: 'added', adds: 1, dels: 0, binary: false });
    expect(byPath.get('new.txt')?.patch).toContain('+brand new');
    expect(byPath.get('mod.txt')).toMatchObject({ status: 'modified', adds: 2, dels: 1 });
    expect(byPath.get('mod.txt')?.patch).toContain('-line two');
    expect(byPath.get('del.txt')).toMatchObject({ status: 'deleted', adds: 0, dels: 1 });
    expect(byPath.get('renamed.txt')).toMatchObject({ status: 'renamed', oldPath: 'ren.txt' });
    expect(byPath.get('bin.dat')).toMatchObject({ status: 'modified', binary: true, adds: 0, dels: 0 });

    expect(result.changes.stat.files).toBe(5);
    expect(result.changes.stat.adds).toBe(result.changes.files.reduce((s, f) => s + f.adds, 0));
    expect(result.changes.stat.dels).toBe(result.changes.files.reduce((s, f) => s + f.dels, 0));
  });

  it('flags image paths with image:true (#365) — even ones git does not mark binary', async () => {
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    g(dir, 'checkout', '-b', 'task');

    writeFileSync(join(dir, 'photo.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
    // SVG is text — git will not flag it binary — but it is still an image by extension.
    writeFileSync(join(dir, 'icon.svg'), '<svg></svg>\n');
    writeFileSync(join(dir, 'notes.txt'), 'plain text, not an image\n');
    g(dir, 'add', '-A');

    const result = await collectChanges(dir, 'main');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = new Map(result.changes.files.map((f) => [f.path, f]));

    expect(byPath.get('photo.png')).toMatchObject({ binary: true, image: true });
    expect(byPath.get('icon.svg')).toMatchObject({ binary: false, image: true });
    // Non-images never carry the field at all (optional, absent-by-default).
    expect(byPath.get('notes.txt')?.image).toBeUndefined();
    expect('image' in (byPath.get('notes.txt') ?? {})).toBe(false);
  });

  it('an empty diff is a valid all-zero payload, not an error', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');

    const result = await collectChanges(dir, 'main');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.files).toEqual([]);
    expect(result.changes.stat).toEqual({ adds: 0, dels: 0, files: 0 });
  });

  it('limits a repointed task worktree to uncommitted changes', async () => {
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    g(dir, 'checkout', '-b', 'review/pr-42');
    writeFileSync(join(dir, 'reviewed.txt'), 'belongs to the reviewed PR\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'reviewed change');
    writeFileSync(join(dir, 'reviewed.txt'), 'resolved locally by this review task\n');
    g(dir, 'add', 'reviewed.txt');

    const result = await collectChanges(dir, 'main', { taskBranch: 'cez/task1234' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.files.map((file) => file.path)).toEqual(['reviewed.txt']);
    expect(result.changes.repointedHead).toEqual({
      headBranch: 'review/pr-42',
      taskBranch: 'cez/task1234',
    });
  });

  it('keeps what the run committed on a repointed branch, and drops what predates it', async () => {
    // `runStartedAt` turns the repointed answer from "uncommitted work only" into "the
    // branch as this run found it" — the difference between a review run's honest zero
    // and a `feat/…` run's committed work being reported as nothing at all (#751).
    const before = '2026-01-01T00:00:00Z';
    gAt(dir, before, 'commit', '--allow-empty', '-m', 'root');
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    g(dir, 'add', '-A');
    gAt(dir, before, 'commit', '-m', 'base');
    gAt(dir, before, 'checkout', '-b', 'review/pr-42');
    writeFileSync(join(dir, 'theirs.txt'), 'belongs to the reviewed PR\n');
    g(dir, 'add', '-A');
    gAt(dir, before, 'commit', '-m', 'reviewed change');
    // Everything below happens during the run.
    writeFileSync(join(dir, 'mine.txt'), 'the run committed this\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'the run\'s own commit');
    writeFileSync(join(dir, 'wip.txt'), 'uncommitted, also the run\'s\n');

    const result = await collectChanges(dir, 'main', {
      taskBranch: 'cez/task1234',
      runStartedAt: '2026-06-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.files.map((file) => file.path).sort()).toEqual(['mine.txt', 'wip.txt']);
    expect(result.changes.repointedHead).toEqual({
      headBranch: 'review/pr-42',
      taskBranch: 'cez/task1234',
    });
  });

  it('keeps committed task changes when HEAD matches the task branch', async () => {
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    g(dir, 'checkout', '-b', 'cez/task1234');
    writeFileSync(join(dir, 'task.txt'), 'task change\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'task change');

    const result = await collectChanges(dir, 'main', { taskBranch: 'cez/task1234' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.files.map((file) => file.path)).toEqual(['task.txt']);
    expect(result.changes.repointedHead).toBeUndefined();
  });

  it('caps oversized per-file patches with a truncation note', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    writeFileSync(join(dir, 'a.txt'), `${'x'.repeat(500)}\n`.repeat(20));

    const result = await collectChanges(dir, 'main', { patchCap: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.files[0]?.patch.length).toBeLessThan(300);
    expect(result.changes.files[0]?.patch).toContain('… (patch truncated)');
  });

  it('intentToAdd:false never stages into the index (#major-index-mutation)', async () => {
    writeFileSync(join(dir, 'tracked.txt'), 'a\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    writeFileSync(join(dir, 'untracked.txt'), 'scratch\n');

    // The read-only main-tree path must NOT run `git add -N` — the file stays untracked.
    const result = await collectChanges(dir, 'main', { intentToAdd: false });
    expect(result.ok).toBe(true);
    const status = execFileSync('git', ['status', '--porcelain', 'untracked.txt'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(status.startsWith('??')).toBe(true); // still untracked, not `A ` (intent-to-add)

    // Default (worktree) behavior still surfaces the untracked file's diff.
    const withAdd = await collectChanges(dir, 'main');
    expect(withAdd.ok).toBe(true);
    if (withAdd.ok) expect(withAdd.changes.files.some((f) => f.path === 'untracked.txt')).toBe(true);
  });

  it('intentToAdd:false leaves the real index untouched on a repointed HEAD too', async () => {
    // Choosing between the two repointed anchors compares them with `git diff --shortstat`,
    // and `git diff` REWRITES the index it reads (a stat refresh). Those probes must run on
    // the scratch index like every other diff here, or a read-only GET against the user's own
    // checkout writes their `.git/index` — the same invariant as the test above, one call
    // deeper.
    const before = '2026-01-01T00:00:00Z';
    gAt(dir, before, 'commit', '--allow-empty', '-m', 'root');
    writeFileSync(join(dir, 'tracked.txt'), 'a\n');
    g(dir, 'add', '-A');
    gAt(dir, before, 'commit', '-m', 'base');
    gAt(dir, before, 'checkout', '-b', 'review/pr-42');
    writeFileSync(join(dir, 'theirs.txt'), 'belongs to the reviewed PR\n');
    g(dir, 'add', '-A');
    gAt(dir, before, 'commit', '-m', 'reviewed change');
    // Backdating a tracked file is what makes the index stale: the recorded stat data no
    // longer matches, git's refresh finds the content clean anyway, and it persists the new
    // stat. (Rewriting the file in-place would not do it — a mtime inside the index's own
    // second is "racily clean" and git declines to record it.)
    const staleTime = new Date(Date.now() - 600_000);
    utimesSync(join(dir, 'tracked.txt'), staleTime, staleTime);
    const indexBefore = readFileSync(join(dir, '.git', 'index'));

    const result = await collectChanges(dir, 'main', {
      intentToAdd: false,
      taskBranch: 'cez/task1234',
      runStartedAt: '2026-06-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.repointedHead?.headBranch).toBe('review/pr-42');
    expect(readFileSync(join(dir, '.git', 'index'))).toEqual(indexBefore);
  });
});

describe('assemblePayload — patches attach to files by path, not by position (#488)', () => {
  // `-z` name-status: `X NUL path NUL`. Two modified files, in this order.
  const nameStatus = 'M\0a.txt\0M\0b.txt\0';
  const numstat = '1\t0\ta.txt\x002\t1\tb.txt\x00';
  const patchA = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-old-a', '+new-a', ''].join(
    '\n',
  );
  const patchB = [
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1,2 @@',
    '-old-b',
    '+new-b',
    '+extra-b',
    '',
  ].join('\n');

  it('keeps a file’s patch when name-status and patch file counts disagree', () => {
    // The regression: a status entry (a.txt) emits no `diff --git` block, so the patch has
    // one section for two files. The old `patches.length === statuses.length` guard blanked
    // EVERY patch; now b.txt keeps its diff and only the genuinely patch-less a.txt is empty.
    const payload = assemblePayload(nameStatus, numstat, patchB, 10_000);
    const byPath = new Map(payload.files.map((f) => [f.path, f]));
    expect(byPath.get('b.txt')?.patch).toContain('+new-b');
    expect(byPath.get('b.txt')?.patch).toContain('+extra-b');
    expect(byPath.get('a.txt')?.patch).toBe('');
    // Counts/stats stay driven by numstat, untouched by the patch association.
    expect(byPath.get('b.txt')).toMatchObject({ adds: 2, dels: 1 });
  });

  it('associates by path even when patch sections are ordered differently than name-status', () => {
    // Both listings have two entries (counts agree), but the patch lists b before a. Positional
    // matching would cross the patches over; path matching keeps each with its own file.
    const payload = assemblePayload(nameStatus, numstat, `${patchB}${patchA}`, 10_000);
    const byPath = new Map(payload.files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')?.patch).toContain('+new-a');
    expect(byPath.get('a.txt')?.patch).not.toContain('new-b');
    expect(byPath.get('b.txt')?.patch).toContain('+new-b');
  });
});

describe('patchByPath — maps a diff section to the file it describes', () => {
  it('keys ordinary, deleted and renamed sections by their name-status path', () => {
    const patch = [
      'diff --git a/mod.txt b/mod.txt',
      '--- a/mod.txt',
      '+++ b/mod.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      '',
    ].join('\n');
    const map = patchByPath(splitPatch(patch));
    // deletion → its removed path (what --name-status reports for the `D` entry)
    expect(map.get('gone.txt')).toContain('+++ /dev/null');
    // rename → its target path (the `R` entry's new path)
    expect(map.get('new.txt')).toContain('rename to new.txt');
    expect(map.get('mod.txt')).toContain('+b');
  });
});

describe('collectRunCommits — the run branch commits since base', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-runcommits-'));
    initRepo(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists only the branch commits past the merge-base, newest first', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    g(dir, 'checkout', '-b', 'task');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'first task commit');
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'second task commit');

    const result = await collectRunCommits(dir, 'main');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commits.map((commit) => commit.subject)).toEqual([
      'second task commit',
      'first task commit',
    ]);
    // The base commit is excluded, and every commit carries a full sha + author.
    expect(result.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha) && c.author === 'cezar-test')).toBe(true);
  });

  it('is empty (not an error) when the branch has no commits past base', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    g(dir, 'checkout', '-b', 'task');
    const result = await collectRunCommits(dir, 'main');
    expect(result).toEqual({ ok: true, commits: [] });
  });
});

describe('readWorktreePath — Files tab browsing', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-files-'));
    mkdirSync(join(dir, '.git')); // stand-in for repo internals
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    writeFileSync(join(dir, 'sub', 'b.txt'), 'beta\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists the root (dirs first, .git hidden) when path is omitted', async () => {
    const res = await readWorktreePath(dir, '');
    expect(res.kind).toBe('dir');
    if (res.kind !== 'dir') return;
    expect(res.entries.map((e) => e.name)).toEqual(['sub', 'a.txt', 'bin.dat']);
    expect(res.entries.find((e) => e.name === 'a.txt')?.size).toBe(6);
  });

  it('lists a subdirectory and reads a file with content', async () => {
    const listing = await readWorktreePath(dir, 'sub');
    expect(listing.kind).toBe('dir');
    if (listing.kind === 'dir') expect(listing.entries).toEqual([{ name: 'b.txt', type: 'file', size: 5 }]);

    const file = await readWorktreePath(dir, 'sub/b.txt');
    expect(file).toMatchObject({ kind: 'file', path: 'sub/b.txt', binary: false, tooLarge: false, content: 'beta\n' });
  });

  it('flags binary files and withholds their content', async () => {
    const res = await readWorktreePath(dir, 'bin.dat');
    expect(res).toMatchObject({ kind: 'file', binary: true });
    if (res.kind === 'file') expect(res.content).toBeUndefined();
  });

  it('withholds content past the size cap with an honest tooLarge flag', async () => {
    const res = await readWorktreePath(dir, 'a.txt', 3);
    expect(res).toMatchObject({ kind: 'file', tooLarge: true, size: 6 });
    if (res.kind === 'file') expect(res.content).toBeUndefined();
  });

  it('rejects traversal, absolute paths, .git and symlinks', async () => {
    expect((await readWorktreePath(dir, '../outside.txt')).kind).toBe('invalid');
    expect((await readWorktreePath(dir, 'sub/../../outside.txt')).kind).toBe('invalid');
    expect((await readWorktreePath(dir, '/etc/passwd')).kind).toBe('invalid');
    expect((await readWorktreePath(dir, '.git')).kind).toBe('invalid');
    expect((await readWorktreePath(dir, '.git/config')).kind).toBe('invalid');
    expect((await readWorktreePath(dir, 'a\0.txt')).kind).toBe('invalid');
    symlinkSync('/etc', join(dir, 'link'));
    expect((await readWorktreePath(dir, 'link')).kind).toBe('invalid');
    expect((await readWorktreePath(dir, 'nope.txt')).kind).toBe('missing');
  });

  it('rejects reads THROUGH an intermediate symlinked directory (#blocker-symlink-traversal)', async () => {
    // A secret file outside the worktree, reached via a symlinked directory inside it.
    const outside = mkdtempSync(join(tmpdir(), 'cez-secret-'));
    writeFileSync(join(outside, 'credentials.txt'), 'SECRET\n');
    symlinkSync(outside, join(dir, 'linkdir'));

    // Before the fix this returned the file's contents from OUTSIDE the worktree.
    const viaLink = await readWorktreePath(dir, 'linkdir/credentials.txt');
    expect(viaLink.kind).toBe('invalid');
    if (viaLink.kind === 'invalid') expect(viaLink.error).toContain('escapes the worktree');

    rmSync(outside, { recursive: true, force: true });
  });
});

describe('imageMimeType — the raw-serving allowlist (R5 Step 1.6)', () => {
  it('maps image extensions case-insensitively', () => {
    expect(imageMimeType('logo.png')).toBe('image/png');
    expect(imageMimeType('deep/dir/Photo.JPEG')).toBe('image/jpeg');
    expect(imageMimeType('pic.jpg')).toBe('image/jpeg');
    expect(imageMimeType('icon.svg')).toBe('image/svg+xml');
    expect(imageMimeType('anim.webp')).toBe('image/webp');
  });

  it('answers null for everything else — non-images never leave as bytes', () => {
    expect(imageMimeType('index.html')).toBeNull();
    expect(imageMimeType('script.js')).toBeNull();
    expect(imageMimeType('README')).toBeNull();
    expect(imageMimeType('.png')).toBeNull(); // a dotfile named ".png" is not an image
    expect(imageMimeType('archive.png.zip')).toBeNull();
  });
});

describe('isOsOpenableImage — the OS-launcher allowlist (#365)', () => {
  it('allows raster images, matching the raw allowlist case-insensitively', () => {
    expect(isOsOpenableImage('logo.png')).toBe(true);
    expect(isOsOpenableImage('deep/dir/Photo.JPEG')).toBe(true);
    expect(isOsOpenableImage('anim.webp')).toBe(true);
    expect(isOsOpenableImage('shot.avif')).toBe(true);
  });

  it('refuses SVG — the raw route\'s CSP does not exist once the OS opens the file', () => {
    // `imageMimeType` says yes (inert in an <img>, plus a no-script CSP); the OS launcher
    // applies neither, and the default .svg handler is usually a script-executing browser.
    expect(imageMimeType('icon.svg')).toBe('image/svg+xml');
    expect(isOsOpenableImage('icon.svg')).toBe(false);
    expect(isOsOpenableImage('deep/ICON.SVG')).toBe(false);
  });

  it('refuses everything the OS would EXECUTE rather than display', () => {
    expect(isOsOpenableImage('build.command')).toBe(false);
    expect(isOsOpenableImage('run.desktop')).toBe(false);
    expect(isOsOpenableImage('setup.exe')).toBe(false);
    expect(isOsOpenableImage('index.html')).toBe(false);
    expect(isOsOpenableImage('README')).toBe(false);
    expect(isOsOpenableImage('.png')).toBe(false); // a dotfile named ".png" is not an image
    expect(isOsOpenableImage('archive.png.zip')).toBe(false);
  });
});

describe('session git API routes', () => {
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;
  let app: Hono;
  let run: RunRecord;
  let repoBaseSha: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gitapi-'));
    initRepo(repoRoot);
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\nwt/\n');
    writeFileSync(join(repoRoot, 'root-base.txt'), 'base\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'root base');
    repoBaseSha = g(repoRoot, 'rev-parse', 'HEAD').trim();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager, // these routes never touch it
      version: '0.0.0-test',
    });
    // The "worktree" fixture is a plain repo — the routes only need a git
    // dir the record points at, not a literal `git worktree add` product.
    worktree = join(repoRoot, 'wt');
    mkdirSync(worktree);
    initRepo(worktree);
    writeFileSync(join(worktree, 'base.txt'), 'base\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-m', 'base');
    g(worktree, 'checkout', '-b', 'task');
    run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { worktreePath: worktree, baseBranch: 'main', branch: 'task' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const commit = (id: string, body: unknown) =>
    apiRequest(app, `/api/v1/runs/${id}/git/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /changes answers the structured shape; 404 for unknown ids', async () => {
    writeFileSync(join(worktree, 'new.txt'), 'hi\n');
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesPayload;
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ path: 'new.txt', status: 'added', adds: 1, dels: 0 });
    expect(body.stat).toEqual({ adds: 1, dels: 0, files: 1 });

    expect((await apiRequest(app, '/api/v1/runs/nope/changes')).status).toBe(404);
  });

  it('GET /changes uses the persisted task branch to detect a repointed HEAD', async () => {
    writeFileSync(join(worktree, 'reviewed.txt'), 'reviewed branch history\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-m', 'reviewed change');
    g(worktree, 'branch', '-m', 'review/pr-42');
    writeFileSync(join(worktree, 'reviewed.txt'), 'uncommitted conflict resolution\n');

    const res = await apiRequest(app, `/api/v1/runs/${run.id}/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesPayload;
    expect(body.files.map((file) => file.path)).toEqual(['reviewed.txt']);
    expect(body.repointedHead).toEqual({ headBranch: 'review/pr-42', taskBranch: 'task' });
  });

  it('runs without a worktree read Changes, Files and Commits from the current checkout', async () => {
    const bare = store.createRun({
      title: 'b',
      workflow: 'quick-task',
      task: 'b',
      worktree: false,
      steps: [],
    });
    store.updateRun(bare.id, { baseBranch: repoBaseSha });

    writeFileSync(join(repoRoot, 'committed.txt'), 'session commit\n');
    g(repoRoot, 'add', 'committed.txt');
    g(repoRoot, 'commit', '-m', 'session commit');
    writeFileSync(join(repoRoot, 'untracked.txt'), 'working copy\n');

    const changes = await apiRequest(app, `/api/v1/runs/${bare.id}/changes`);
    expect(changes.status).toBe(200);
    const changed = (await changes.json()) as ChangesPayload;
    expect(changed.files.map((file) => file.path)).toEqual(['committed.txt', 'untracked.txt']);
    // The read uses a scratch index, so surfacing an untracked file never stages it.
    expect(g(repoRoot, 'status', '--porcelain', 'untracked.txt').startsWith('??')).toBe(true);

    const files = await apiRequest(app, `/api/v1/runs/${bare.id}/files?path=untracked.txt`);
    expect(files.status).toBe(200);
    expect((await files.json()) as object).toMatchObject({ type: 'file', content: 'working copy\n' });

    const commits = await apiRequest(app, `/api/v1/runs/${bare.id}/commits`);
    expect(commits.status).toBe(200);
    const commitList = (await commits.json()) as { commits: Array<{ sha: string; subject: string }> };
    expect(commitList.commits).toHaveLength(1);
    const sessionCommit = commitList.commits[0];
    expect(sessionCommit?.subject).toBe('session commit');
    if (!sessionCommit) throw new Error('expected the session commit');

    const detail = await apiRequest(app, `/api/v1/runs/${bare.id}/commit/${sessionCommit.sha}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()) as object).toMatchObject({
      subject: 'session commit',
      files: [{ path: 'committed.txt', status: 'added' }],
    });

    // Mutations still require an isolated worktree/branch.
    for (const req of [
      commit(bare.id, { message: 'x' }),
      apiRequest(app, `/api/v1/runs/${bare.id}/git/push`, { method: 'POST' }),
    ]) {
      const res = await req;
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('no worktree');
    }
  });

  it('runs whose isolated worktree was removed never fall through to the current checkout', async () => {
    const removed = store.createRun({ title: 'removed', workflow: 'quick-task', task: 'removed', steps: [] });
    store.updateRun(removed.id, {
      worktreePath: join(repoRoot, 'removed-worktree'),
      branch: 'cez/removed',
      baseBranch: repoBaseSha,
    });
    store.updateRun(removed.id, { worktreePath: undefined, branch: undefined });

    for (const req of [
      apiRequest(app, `/api/v1/runs/${removed.id}/changes`),
      apiRequest(app, `/api/v1/runs/${removed.id}/files`),
      apiRequest(app, `/api/v1/runs/${removed.id}/commits`),
      apiRequest(app, `/api/v1/runs/${removed.id}/commit/${repoBaseSha}`),
    ]) {
      const res = await req;
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('no worktree');
    }
  });

  it('GET /commits lists the run branch commits; /commit/:sha gives a structured diff', async () => {
    // A commit on the task branch past the base.
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-m', 'add feature');

    const list = await apiRequest(app, `/api/v1/runs/${run.id}/commits`);
    expect(list.status).toBe(200);
    const { commits } = (await list.json()) as { commits: Array<{ sha: string; subject: string }> };
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('add feature');

    const sha = commits[0]!.sha;
    const diff = await apiRequest(app, `/api/v1/runs/${run.id}/commit/${sha}`);
    expect(diff.status).toBe(200);
    const commit = (await diff.json()) as { files: Array<{ path: string; status: string }> };
    expect(commit.files[0]).toMatchObject({ path: 'feature.txt', status: 'added' });

    // Unknown run id → 404 (not 409), like the other run-scoped routes.
    expect((await apiRequest(app, '/api/v1/runs/nope/commits')).status).toBe(404);
  });

  it('GET /files lists and reads inside the worktree, 409s traversal', async () => {
    const listing = await apiRequest(app, `/api/v1/runs/${run.id}/files`);
    expect(listing.status).toBe(200);
    expect((await listing.json()) as object).toMatchObject({ type: 'dir', path: '' });

    const file = await apiRequest(app, `/api/v1/runs/${run.id}/files?path=base.txt`);
    expect(file.status).toBe(200);
    expect((await file.json()) as object).toMatchObject({ type: 'file', content: 'base\n' });

    const evil = await apiRequest(app, `/api/v1/runs/${run.id}/files?path=${encodeURIComponent('../../etc/passwd')}`);
    expect(evil.status).toBe(409);
    expect(((await evil.json()) as { error: string }).error).toContain('escapes the worktree');
  });

  // 1×1 transparent PNG — real bytes, so the sniffer and the wire agree it is binary.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('GET /files?raw=1 serves image bytes with the image content-type and a no-script CSP', async () => {
    writeFileSync(join(worktree, 'logo.png'), PNG);
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/files?path=logo.png&raw=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('GET /files?raw=1 refuses non-images — a worktree HTML file can never become a document', async () => {
    writeFileSync(join(worktree, 'page.html'), '<script>alert(1)</script>\n');
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/files?path=page.html&raw=1`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('limited to images');
  });

  it('GET /files?raw=1 refuses images past the size cap with a reason', async () => {
    const huge = Buffer.alloc(FILE_CONTENT_CAP + 1);
    PNG.copy(huge); // PNG magic up front, NULs after — binary, image extension, over cap
    writeFileSync(join(worktree, 'huge.png'), huge);
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/files?path=huge.png&raw=1`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('too large');
  });

  it('GET /files?raw=1 still rejects traversal with a 409', async () => {
    const res = await apiRequest(app,
      `/api/v1/runs/${run.id}/files?path=${encodeURIComponent('../../etc/passwd')}&raw=1`,
    );
    expect(res.status).toBe(409);
  });

  // ---- content negotiation on /files: `Accept` as the ADDITIVE fallback to `?raw=` ----------
  //
  // Precedence is flag → Accept → the route's JSON default (see `negotiate` in server.ts). The
  // flag half above is unchanged and stays the live wire; these pin the other two rungs.

  const files = (query: string, accept?: string) =>
    apiRequest(app, `/api/v1/runs/${run.id}/files?${query}`, {
      ...(accept === undefined ? {} : { headers: { accept } }),
    });

  it('GET /files with an image Accept serves the bytes without any raw flag', async () => {
    writeFileSync(join(worktree, 'logo.png'), PNG);
    // What an <img> actually sends: several concrete image types, `image/*`, then `*/*;q=0.8`.
    const res = await files(
      'path=logo.png',
      'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('vary')).toBe('Accept');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('GET /files with `*/*` — every fetch/XHR — still gets the JSON metadata', async () => {
    writeFileSync(join(worktree, 'logo.png'), PNG);
    const res = await files('path=logo.png', '*/*');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()) as object).toMatchObject({ type: 'file', path: 'logo.png' });
  });

  it('GET /files with no Accept at all keeps the JSON default', async () => {
    writeFileSync(join(worktree, 'logo.png'), PNG);
    const res = await files('path=logo.png');
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ type: 'file' });
  });

  it('the raw flag wins over Accept in BOTH directions', async () => {
    writeFileSync(join(worktree, 'logo.png'), PNG);
    // Present-but-not-`1` is an explicit opt-out: the image Accept must not re-decide it.
    const optedOut = await files('path=logo.png&raw=0', 'image/png');
    expect(optedOut.status).toBe(200);
    expect((await optedOut.json()) as object).toMatchObject({ type: 'file' });
    // And `raw=1` still serves bytes to a caller asking for JSON.
    const optedIn = await files('path=logo.png&raw=1', 'application/json');
    expect(optedIn.status).toBe(200);
    expect(optedIn.headers.get('content-type')).toBe('image/png');
  });

  it('an image Accept on a directory is still the JSON listing', async () => {
    const res = await files('path=', 'image/*');
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ type: 'dir', path: '' });
  });

  it('an image Accept on a NON-image falls back to JSON — only `raw=1` earns the 409', async () => {
    writeFileSync(join(worktree, 'page.html'), '<script>alert(1)</script>\n');
    // A preference the resource cannot satisfy is not an error: a browser navigating here (its
    // Accept lists image/avif & co at q=1) must still see the metadata it saw before.
    const negotiated = await files('path=page.html', 'image/avif,image/webp,image/*,*/*;q=0.8');
    expect(negotiated.status).toBe(200);
    expect((await negotiated.json()) as object).toMatchObject({ type: 'file', path: 'page.html' });
    // The flag still says why, verbatim — that 409 is the protected surface.
    const asked = await files('path=page.html&raw=1', 'image/*');
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { error: string }).error).toContain('limited to images');
  });

  it('an over-cap image negotiates back to JSON, but `raw=1` still 409s with the size reason', async () => {
    const huge = Buffer.alloc(FILE_CONTENT_CAP + 1);
    PNG.copy(huge);
    writeFileSync(join(worktree, 'huge.png'), huge);
    const negotiated = await files('path=huge.png', 'image/*');
    expect(negotiated.status).toBe(200);
    expect((await negotiated.json()) as object).toMatchObject({ type: 'file', tooLarge: true });
    const asked = await files('path=huge.png&raw=1', 'image/*');
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { error: string }).error).toContain('too large');
  });

  it('q-values decide when a request asks for both representations', async () => {
    writeFileSync(join(worktree, 'logo.png'), PNG);
    const wantsJson = await files('path=logo.png', 'image/png;q=0.2, application/json;q=0.9');
    expect(wantsJson.headers.get('content-type')).toContain('application/json');
    const wantsBytes = await files('path=logo.png', 'image/png;q=0.9, application/json;q=0.2');
    expect(wantsBytes.headers.get('content-type')).toBe('image/png');
    // `q=0` is a refusal, not a preference — it never selects a representation.
    const refused = await files('path=logo.png', 'image/png;q=0');
    expect(refused.headers.get('content-type')).toContain('application/json');
  });

  it('POST git/commit commits everything; a clean tree is a 409, a bad body a 400', async () => {
    writeFileSync(join(worktree, 'feat.txt'), 'feature\n');
    const res = await commit(run.id, { message: 'feat: add feature' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { committed: boolean; sha: string };
    expect(body.committed).toBe(true);
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(g(worktree, 'log', '-1', '--pretty=%s')).toContain('feat: add feature');
    expect(g(worktree, 'status', '--porcelain').trim()).toBe('');

    // Nothing left to commit — predictable git failure, 409 with a reason.
    const clean = await commit(run.id, { message: 'again' });
    expect(clean.status).toBe(409);
    expect(((await clean.json()) as { error: string }).error).toContain('nothing to commit');

    expect((await commit(run.id, { message: '   ' })).status).toBe(400);
    expect((await commit(run.id, {})).status).toBe(400);
  });

  it('POST git/push with no remote is a 409 with a human reason', async () => {
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/git/push`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no remote configured');
  });

  it('POST git/push sets upstream on first push to a real remote', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'cez-remote-'));
    try {
      execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
      g(worktree, 'remote', 'add', 'origin', remote);

      const first = await apiRequest(app, `/api/v1/runs/${run.id}/git/push`, { method: 'POST' });
      expect(first.status).toBe(200);
      expect((await first.json()) as object).toMatchObject({ pushed: true, branch: 'task', remote: 'origin', upstreamSet: true });

      // Second push goes through the existing upstream.
      const second = await apiRequest(app, `/api/v1/runs/${run.id}/git/push`, { method: 'POST' });
      expect(second.status).toBe(200);
      expect((await second.json()) as object).toMatchObject({ pushed: true, upstreamSet: false });
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });
});

describe('repo git API routes (R5 Step 1.3 — main working tree)', () => {
  let repoRoot: string;
  let app: Hono;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-repoapi-'));
    initRepo(repoRoot);
    // The RunStore lives inside the repo (.ai/cezar) — ignore it so it never
    // shows up in /api/v1/repo/changes.
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'base');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager, // these routes never touch it
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const branch = (body: unknown) =>
    apiRequest(app, '/api/v1/repo/branch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /api/v1/repo/changes reports uncommitted main-tree changes vs HEAD', async () => {
    writeFileSync(join(repoRoot, 'base.txt'), 'base changed\n');
    writeFileSync(join(repoRoot, 'new.txt'), 'brand new\n');

    const res = await apiRequest(app, '/api/v1/repo/changes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesPayload;
    const byPath = new Map(body.files.map((f) => [f.path, f]));
    expect(byPath.get('base.txt')).toMatchObject({ status: 'modified', adds: 1, dels: 1 });
    expect(byPath.get('new.txt')).toMatchObject({ status: 'added', adds: 1, dels: 0 });
    expect(byPath.get('new.txt')?.patch).toContain('+brand new');
    expect(body.stat).toEqual({ adds: 2, dels: 1, files: 2 });
  });

  it('GET /api/v1/repo/changes on a clean tree is an all-zero payload, not an error', async () => {
    const res = await apiRequest(app, '/api/v1/repo/changes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesPayload;
    expect(body.files).toEqual([]);
    expect(body.stat).toEqual({ adds: 0, dels: 0, files: 0 });
  });

  it('POST /api/v1/repo/branch creates a branch from HEAD and switches to it', async () => {
    const res = await branch({ name: 'feature' });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ branch: 'feature', created: true });
    expect(g(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature');
  });

  it('POST /api/v1/repo/branch creates from an explicit start point', async () => {
    const mainSha = g(repoRoot, 'rev-parse', 'HEAD').trim();
    // Move ahead on a side branch so `from: main` is not just HEAD.
    g(repoRoot, 'checkout', '-b', 'side');
    writeFileSync(join(repoRoot, 'side.txt'), 'side\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'side work');

    const res = await branch({ name: 'from-main', from: 'main' });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ branch: 'from-main', created: true });
    expect(g(repoRoot, 'rev-parse', 'HEAD').trim()).toBe(mainSha);
  });

  it('POST /api/v1/repo/branch switches to an existing branch without recreating it', async () => {
    g(repoRoot, 'checkout', '-b', 'existing');
    g(repoRoot, 'checkout', 'main');

    const res = await branch({ name: 'existing' });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ branch: 'existing', created: false });
    expect(g(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('existing');
  });

  it('an invalid branch name is a 409 with a reason (git check-ref-format rules)', async () => {
    for (const name of ['bad..name', 'has space', 'trailing.lock', '-dash']) {
      const res = await branch({ name });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('invalid branch name');
    }
    expect(g(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('an unknown start point is a 409 with a reason', async () => {
    const res = await branch({ name: 'ok-name', from: 'no-such-ref' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('unknown start point');
  });

  it('a dirty-tree checkout conflict is a 409 with git’s own reason', async () => {
    g(repoRoot, 'checkout', '-b', 'other');
    writeFileSync(join(repoRoot, 'base.txt'), 'other version\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'diverge');
    g(repoRoot, 'checkout', 'main');
    writeFileSync(join(repoRoot, 'base.txt'), 'uncommitted local edit\n');

    const res = await branch({ name: 'other' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error.toLowerCase()).toContain('local changes');
    expect(g(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('a bad body is a 400 (missing, blank, or non-JSON)', async () => {
    expect((await branch({})).status).toBe(400);
    expect((await branch({ name: '   ' })).status).toBe(400);
    const res = await apiRequest(app, '/api/v1/repo/branch', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  // ---- GET /api/v1/repo/commit/:sha (R5 Step 1.7 — structured sibling) ----------

  it('GET /api/v1/repo/commit/:sha without the flag keeps the legacy text-blob shape', async () => {
    const sha = g(repoRoot, 'rev-parse', 'HEAD').trim();
    const res = await apiRequest(app, `/api/v1/repo/commit/${sha}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain(`commit ${sha}`);
    expect(text).toContain('base');
  });

  it('?structured=1 answers {sha, subject, author, when, files, stat} with per-file patches', async () => {
    writeFileSync(join(repoRoot, 'base.txt'), 'base changed\n');
    writeFileSync(join(repoRoot, 'new.txt'), 'brand new\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'second: edit + add');
    const sha = g(repoRoot, 'rev-parse', 'HEAD').trim();

    const res = await apiRequest(app, `/api/v1/repo/commit/${sha}?structured=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sha: string;
      subject: string;
      author: string;
      when: string;
      files: Array<{ path: string; status: string; adds: number; dels: number; patch: string }>;
      stat: { adds: number; dels: number; files: number };
    };
    expect(body.sha).toBe(sha);
    expect(body.subject).toBe('second: edit + add');
    expect(body.author).toBe('cezar-test');
    expect(body.when.length).toBeGreaterThan(0);
    const byPath = new Map(body.files.map((f) => [f.path, f]));
    expect(byPath.get('base.txt')).toMatchObject({ status: 'modified', adds: 1, dels: 1 });
    expect(byPath.get('new.txt')).toMatchObject({ status: 'added', adds: 1, dels: 0 });
    expect(byPath.get('new.txt')?.patch).toContain('+brand new');
    expect(body.stat).toEqual({ adds: 2, dels: 1, files: 2 });
  });

  it('?structured=1 handles the root commit (no parent) and abbreviated shas', async () => {
    const full = g(repoRoot, 'rev-parse', 'HEAD').trim();
    const res = await apiRequest(app, `/api/v1/repo/commit/${full.slice(0, 8)}?structured=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha: string; files: Array<{ path: string }> };
    // The abbreviation resolves to the full sha, and --root diffs the initial commit.
    expect(body.sha).toBe(full);
    expect(body.files.map((f) => f.path).sort()).toEqual(['.gitignore', 'base.txt']);
  });

  it('?structured=1 answers zero files for a merge commit — no invented side', async () => {
    g(repoRoot, 'checkout', '-b', 'feature');
    writeFileSync(join(repoRoot, 'feature.txt'), 'feature work\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'feature work');
    g(repoRoot, 'checkout', 'main');
    writeFileSync(join(repoRoot, 'main.txt'), 'main work\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'main work');
    g(repoRoot, 'merge', '--no-ff', '-m', 'merge feature', 'feature');
    const sha = g(repoRoot, 'rev-parse', 'HEAD').trim();

    const res = await apiRequest(app, `/api/v1/repo/commit/${sha}?structured=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string; files: unknown[]; stat: { files: number } };
    expect(body.subject).toBe('merge feature');
    expect(body.files).toEqual([]);
    expect(body.stat.files).toBe(0);
  });

  it('?structured=1 with an unknown or invalid sha is a 409 with a reason, never HTML', async () => {
    const unknown = await apiRequest(app, '/api/v1/repo/commit/deadbeefdeadbeef?structured=1');
    expect(unknown.status).toBe(409);
    expect(((await unknown.json()) as { error: string }).error.length).toBeGreaterThan(0);

    const invalid = await apiRequest(app, '/api/v1/repo/commit/not-a-sha?structured=1');
    expect(invalid.status).toBe(409);
    expect(((await invalid.json()) as { error: string }).error).toContain('not a commit hash');
  });

  // ---- content negotiation: `Accept` as the ADDITIVE fallback to `?structured=` --------------
  //
  // Precedence is flag → Accept → this route's TEXT default (see `negotiate` in server.ts). The
  // default deliberately stays the legacy blob: it is the answer every pre-Accept caller gets and
  // a protected surface (BACKWARD_COMPATIBILITY.md §2), so "JSON by default" was not on offer.

  const commit = (suffix: string, accept?: string) =>
    apiRequest(app, `/api/v1/repo/commit/${g(repoRoot, 'rev-parse', 'HEAD').trim()}${suffix}`, {
      ...(accept === undefined ? {} : { headers: { accept } }),
    });

  it('Accept: application/json reaches the structured answer with no flag at all', async () => {
    const res = await commit('', 'application/json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('vary')).toBe('Accept');
    const body = (await res.json()) as { sha: string; files: unknown[] };
    expect(body.sha).toBe(g(repoRoot, 'rev-parse', 'HEAD').trim());
  });

  it('Accept: text/plain, `*/*` and no header at all all keep the legacy blob', async () => {
    for (const accept of ['text/plain', '*/*', undefined]) {
      const res = await commit('', accept);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('commit ');
    }
  });

  it('a browser navigation (text/html …) keeps the legacy blob', async () => {
    const res = await commit(
      '',
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    );
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('the structured flag wins over Accept in BOTH directions', async () => {
    const optedOut = await commit('?structured=0', 'application/json');
    expect(optedOut.headers.get('content-type')).toContain('text/plain');
    const optedIn = await commit('?structured=1', 'text/plain');
    expect(optedIn.headers.get('content-type')).toContain('application/json');
  });

  it('q-values decide when a request asks for both representations', async () => {
    const wantsText = await commit('', 'application/json;q=0.3, text/plain;q=0.8');
    expect(wantsText.headers.get('content-type')).toContain('text/plain');
    const wantsJson = await commit('', 'application/json;q=0.8, text/plain;q=0.3');
    expect(wantsJson.headers.get('content-type')).toContain('application/json');
    // Equal weights go to the route's default — the offer list is the server's preference order.
    const tied = await commit('', 'application/json, text/plain');
    expect(tied.headers.get('content-type')).toContain('text/plain');
  });
});

describe('createOrSwitchBranch — dash-guard on both operands (#431)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-dashguard-'));
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects an option-like branch name — it reaches `checkout [-b] <name>` positionally', async () => {
    for (const name of ['-x', '--force', '-']) {
      const res = await createOrSwitchBranch(dir, name);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('invalid branch name');
    }
    expect(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('rejects an option-like start point', async () => {
    const res = await createOrSwitchBranch(dir, 'ok-name', '--upload-pack=touch /tmp/pwn');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('invalid start point');
  });

  it('still creates an ordinary branch', async () => {
    const res = await createOrSwitchBranch(dir, 'feature', 'main');
    expect(res).toEqual({ ok: true, branch: 'feature', created: true });
  });
});

describe('commitAll / pushCurrentBranch — direct degradation paths', () => {
  it('commitAll on a non-repo dir fails with a reason, never throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-norepo-'));
    try {
      const res = await commitAll(dir, 'msg');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.toLowerCase()).toContain('not a git repository');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pushCurrentBranch reports detached HEAD as a reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-detached-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      g(dir, 'add', '-A');
      g(dir, 'commit', '-m', 'base');
      g(dir, 'checkout', '--detach');
      const res = await pushCurrentBranch(dir);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('detached HEAD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
