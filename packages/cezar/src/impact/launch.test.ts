import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand, type CommandRunner } from '../automations/pr-head.ts';
import { extractTaskRefs } from '../runs/task-refs.ts';
import type { RunRecord } from '../runs/store.ts';
import { GH_UNAVAILABLE, isSpecPath, newestSubjectRun, resolveImpactSubject, subjectStale } from './launch.ts';

/**
 * `POST /impact`'s subject resolution (spec 2026-10-22-html-artifacts-and-impact Q8–Q10).
 * The guards come first: a path outside `.ai/specs` or outside the index, a closed PR, a fork
 * and a missing `gh` are each refused before any run exists.
 */

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const REPO = { owner: 'acme', name: 'shop' };

let root: string;
let head: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-impact-launch-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, '.ai/specs/sub'), { recursive: true });
  writeFileSync(join(root, '.ai/specs/feature.md'), '# Feature\n');
  writeFileSync(join(root, '.ai/specs/sub/nested.md'), '# Nested\n');
  writeFileSync(join(root, 'README.md'), '# Readme\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** `gh api` answers `pull`; `git fetch` points the ref at `head`; every other git runs for real. */
function github(pull: Record<string, unknown> | null, ghStderr?: string): CommandRunner {
  return async (command, args, cwd) => {
    if (command === 'gh') return ghStderr ? { ok: false, stdout: '', stderr: ghStderr } : { ok: true, stdout: JSON.stringify(pull), stderr: '' };
    if (args[0] === 'fetch') return runCommand('git', ['update-ref', args.at(-1)!.split(':')[1]!, head], cwd);
    return runCommand(command, args, cwd);
  };
}
const pull = (over: Record<string, unknown> = {}) => ({
  state: 'open',
  title: 'Login  fix',
  html_url: 'https://github.com/acme/shop/pull/42',
  head: { sha: head, ref: 'feature/login', repo: { full_name: 'acme/shop' } },
  base: { ref: 'main' },
  ...over,
});
const deps = (runner: CommandRunner) => ({ run: runner, repoHandle: async () => REPO, env: {} });

describe('spec subject — guards', () => {
  it('refuses a path outside .ai/specs, a non-Markdown file and any traversal (409)', async () => {
    for (const path of ['README.md', '.ai/specs/../README.md', '/etc/passwd', '.ai/specs/./feature.md', '.ai/specs\\feature.md', '.ai/specs/feature.txt', '.ai/specsx/a.md']) {
      expect(isSpecPath(path), path).toBe(false);
      const result = await resolveImpactSubject(root, { kind: 'spec', path });
      expect(result, path).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('.ai/specs/') });
    }
  });

  it('refuses a spec-shaped path that is not in the repository index (409)', async () => {
    expect(await resolveImpactSubject(root, { kind: 'spec', path: '.ai/specs/missing.md' })).toEqual({
      ok: false, status: 409, error: '.ai/specs/missing.md is not a file in this repository',
    });
    // Ignored files never reach the index either.
    writeFileSync(join(root, '.gitignore'), '.ai/specs/ignored.md\n');
    writeFileSync(join(root, '.ai/specs/ignored.md'), '# ignored\n');
    expect(await resolveImpactSubject(root, { kind: 'spec', path: '.ai/specs/ignored.md' })).toMatchObject({
      ok: false, status: 409, error: '.ai/specs/ignored.md is not a file in this repository',
    });
    // An untracked file is listed by the Files view, but has no blob to pin.
    writeFileSync(join(root, '.ai/specs/untracked.md'), '# not added\n');
    expect(await resolveImpactSubject(root, { kind: 'spec', path: '.ai/specs/untracked.md' })).toMatchObject({
      ok: false, status: 409, error: expect.stringContaining('not committed'),
    });
  });

  it('refuses a staged spec not yet committed on HEAD (409)', async () => {
    writeFileSync(join(root, '.ai/specs/staged.md'), '# staged\n');
    await run('git', ['add', '.ai/specs/staged.md'], { cwd: root });
    expect(await resolveImpactSubject(root, { kind: 'spec', path: '.ai/specs/staged.md' })).toMatchObject({
      ok: false, status: 409, error: expect.stringContaining('not committed'),
    });
  });

  it('refuses a directory that is not a git repository (409)', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-impact-plain-'));
    expect(await resolveImpactSubject(plain, { kind: 'spec', path: '.ai/specs/feature.md' })).toMatchObject({ ok: false, status: 409 });
    rmSync(plain, { recursive: true, force: true });
  });

  it('pins a tracked spec by its blob sha at HEAD, with the spec task text', async () => {
    const blob = (await run('git', ['rev-parse', 'HEAD:.ai/specs/sub/nested.md'], { cwd: root })).stdout.trim();
    expect(await resolveImpactSubject(root, { kind: 'spec', path: '.ai/specs/sub/nested.md' })).toEqual({
      ok: true,
      launch: { task: 'Assess the impact of the spec .ai/specs/sub/nested.md', subject: { kind: 'spec', path: '.ai/specs/sub/nested.md', blobSha: blob } },
    });
  });
});

describe('PR subject — guards', () => {
  it('a closed PR is refused (409) and nothing is fetched', async () => {
    const result = await resolveImpactSubject(root, { kind: 'pr', number: 42 }, deps(github(pull({ state: 'closed' }))));
    expect(result).toEqual({ ok: false, status: 409, error: 'pull request #42 is not open — only an open pull request can be assessed' });
    expect((await run('git', ['for-each-ref', 'refs/cezar/pr/'], { cwd: root })).stdout).toBe('');
  });

  it('a fork head is refused (409), a deleted fork too', async () => {
    for (const repo of [{ full_name: 'stranger/shop' }, null]) {
      const result = await resolveImpactSubject(root, { kind: 'pr', number: 42 }, deps(github(pull({ head: { sha: head, ref: 'x', repo } }))));
      expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('fork') });
    }
  });

  it('no gh (or no GitHub remote) is a 409 with a human reason', async () => {
    expect(await resolveImpactSubject(root, { kind: 'pr', number: 42 }, { repoHandle: async () => null, env: {} })).toEqual({
      ok: false, status: 409, error: GH_UNAVAILABLE,
    });
    const missing = await resolveImpactSubject(root, { kind: 'pr', number: 42 }, deps(github(null, 'spawn gh ENOENT')));
    expect(missing).toEqual({ ok: false, status: 409, error: GH_UNAVAILABLE });
  });

  it('a PR the repository does not have is a 404', async () => {
    const result = await resolveImpactSubject(root, { kind: 'pr', number: 9999 }, deps(github(null, 'gh: Not Found (HTTP 404)')));
    expect(result).toEqual({ ok: false, status: 404, error: 'pull request #9999 not found in acme/shop' });
  });

  it('an open same-repo PR is fetched, pinned and worded so task-refs attributes it', async () => {
    const result = await resolveImpactSubject(root, { kind: 'pr', number: 42 }, deps(github(pull())));
    expect(result).toMatchObject({
      ok: true,
      launch: {
        task: 'Assess the impact of GitHub pull request #42: Login fix\n\nhttps://github.com/acme/shop/pull/42',
        subject: { kind: 'pr', number: 42, headSha: head },
        forkRef: { sha: head, label: 'pr/42', prUrl: 'https://github.com/acme/shop/pull/42', untrusted: false, pr: { number: 42, ref: 'refs/cezar/pr/42' } },
      },
    });
    if (!result.ok) throw new Error('unreachable');
    expect(extractTaskRefs(result.launch.task).prNumber).toBe(42);
    expect((await run('git', ['rev-parse', 'refs/cezar/pr/42'], { cwd: root })).stdout.trim()).toBe(head);
  });

  it('refreshes the base branch, so the evidence can pin a base tip the clone had not fetched', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'cez-impact-remote-'));
    const other = mkdtempSync(join(tmpdir(), 'cez-impact-other-'));
    try {
      await run('git', ['clone', '-q', '--bare', root, remote]);
      await run('git', ['remote', 'add', 'origin', remote], { cwd: root });
      await run('git', ['fetch', '-q', 'origin'], { cwd: root });
      // main moves on GitHub after the user's last fetch.
      await run('git', ['clone', '-q', remote, other]);
      writeFileSync(join(other, 'later.md'), '# later\n');
      await run('git', ['add', '-A'], { cwd: other });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'later'], { cwd: other });
      await run('git', ['push', '-q', 'origin', 'main'], { cwd: other });
      const tip = (await run('git', ['rev-parse', 'HEAD'], { cwd: other })).stdout.trim();
      const missing = await run('git', ['cat-file', '-e', `${tip}^{commit}`], { cwd: root }).then(() => false, () => true);
      expect(missing).toBe(true);

      expect(await resolveImpactSubject(root, { kind: 'pr', number: 42 }, deps(github(pull())))).toMatchObject({ ok: true });
      expect((await run('git', ['rev-parse', 'origin/main'], { cwd: root })).stdout.trim()).toBe(tip);
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('CEZ_DRY_RUN=1 skips gh and the fetch: the fixture head is HEAD', async () => {
    const calls: string[] = [];
    const spy: CommandRunner = async (command, args, cwd) => {
      calls.push(`${command} ${args[0]}`);
      return runCommand(command, args, cwd);
    };
    const result = await resolveImpactSubject(root, { kind: 'pr', number: 7 }, { run: spy, env: { CEZ_DRY_RUN: '1' } });
    expect(result).toMatchObject({ ok: true, launch: { subject: { kind: 'pr', number: 7, headSha: head } } });
    expect(calls.some((c) => c.startsWith('gh') || c === 'git fetch')).toBe(false);
  });
});

describe('newestSubjectRun / subjectStale', () => {
  const record = (id: string, createdAt: string, subject?: RunRecord['subject']) => ({ id, createdAt, subject }) as RunRecord;

  it('picks the newest run with exactly that subject', () => {
    const runs = [
      record('a', '2026-10-01T00:00:00Z', { kind: 'pr', number: 42, headSha: 'x' }),
      record('b', '2026-10-03T00:00:00Z', { kind: 'pr', number: 42, headSha: 'y' }),
      record('c', '2026-10-04T00:00:00Z', { kind: 'pr', number: 43, headSha: 'z' }),
      record('d', '2026-10-05T00:00:00Z', { kind: 'spec', path: '.ai/specs/feature.md', blobSha: 'q' }),
      record('e', '2026-10-06T00:00:00Z'),
    ];
    expect(newestSubjectRun(runs, { kind: 'pr', number: 42 })?.id).toBe('b');
    expect(newestSubjectRun(runs, { kind: 'spec', path: '.ai/specs/feature.md' })?.id).toBe('d');
    expect(newestSubjectRun(runs, { kind: 'spec', path: '.ai/specs/other.md' })).toBeUndefined();
  });

  it('spec: stale once the blob at HEAD moves; null when the spec is gone', async () => {
    const blob = (await run('git', ['rev-parse', 'HEAD:.ai/specs/feature.md'], { cwd: root })).stdout.trim();
    const subject = { kind: 'spec' as const, path: '.ai/specs/feature.md', blobSha: blob };
    expect(await subjectStale(root, subject)).toBe(false);
    writeFileSync(join(root, '.ai/specs/feature.md'), '# Feature v2\n');
    await run('git', [...GIT_ID, 'commit', '-q', '-am', 'edit'], { cwd: root });
    expect(await subjectStale(root, subject)).toBe(true);
    await run('git', ['rm', '-q', '.ai/specs/feature.md'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'rm'], { cwd: root });
    expect(await subjectStale(root, subject)).toBeNull();
  });

  it('PR: compares the head GitHub reports now; null when GitHub cannot say', async () => {
    const subject = { kind: 'pr' as const, number: 42, headSha: head };
    expect(await subjectStale(root, subject, { prHeadSha: async () => head.toUpperCase(), env: {} })).toBe(false);
    expect(await subjectStale(root, subject, { prHeadSha: async () => 'f'.repeat(40), env: {} })).toBe(true);
    expect(await subjectStale(root, subject, { prHeadSha: async () => null, env: {} })).toBeNull();
  });
});
