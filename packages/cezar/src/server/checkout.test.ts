import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import {
  checkoutRepo,
  cleanupCheckout,
  ghCloneArgs,
  ghCloneRunner,
  glabCloneArgs,
  glabCloneRunner,
  isValidCheckoutName,
  parseRepoRef,
  type CloneRunner,
} from './checkout.ts';
import { __setForgeHostsForTests } from './forge/index.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import {
  WorkspaceEventBus,
  createApp,
  type ProjectsResponse,
  type RegisterProjectResponse,
  type ServerDeps,
} from './server.ts';

/**
 * GUI clone (spec 2026-07-20-multi-project-workspace, step 4.3):
 * `POST /api/v1/projects/checkout`, the `checkout-progress` feed, and — the part
 * that earns most of this file — the partial-clone cleanup guard.
 *
 * Everything runs against real temp directories with an INJECTED clone runner.
 * Nothing here mocks `checkoutRepo`, `cleanupCheckout` or the filesystem: the
 * thing under test is precisely "what ends up on disk", so faking the disk
 * would test nothing at all. The injected runner stands in for `gh` only —
 * it writes real files into the real target the module created.
 */

describe('checkout — repo reference parsing', () => {
  it('accepts every GitHub spelling and normalizes to owner/repo', () => {
    for (const input of [
      'open-mercato/cezar',
      'https://github.com/open-mercato/cezar',
      'https://github.com/open-mercato/cezar.git',
      'http://www.github.com/open-mercato/cezar/',
      'github.com/open-mercato/cezar',
      'git@github.com:open-mercato/cezar.git',
      'ssh://git@github.com/open-mercato/cezar',
      '  open-mercato/cezar  ',
    ]) {
      expect(parseRepoRef(input), input).toEqual({
        kind: 'github',
        owner: 'open-mercato',
        repo: 'cezar',
        slug: 'open-mercato/cezar',
        cloneUrl: 'https://github.com/open-mercato/cezar.git',
      });
    }
  });

  it('refuses non-GitHub, malformed and argv-smuggling inputs', () => {
    for (const input of [
      '',
      '   ',
      'cezar',
      'open-mercato/cezar/extra',
      'https://bitbucket.org/owner/repo',
      'git@bitbucket.org:owner/repo.git',
      'https://evil.example/github.com/owner/repo',
      // A github.com URL the GitHub shape refuses never falls through to the
      // GitLab parser, and a GitHub Enterprise host stays out of this flow.
      'git://github.com/owner/repo',
      'https://github.example.com/owner/repo',
      '--upload-pack=touch /tmp/pwned',
      'owner/--flag',
      '../../etc/passwd',
      'owner/repo; rm -rf /',
      'a'.repeat(600),
    ]) {
      expect(parseRepoRef(input), input).toBeNull();
    }
  });

  describe('GitLab sources (spec 2026-08-10-forge-provider-adapters, Step 4.2)', () => {
    beforeEach(() => {
      // An on-prem instance discovery would have classified, and a GHE host to
      // prove only `gitlab` hosts take this path.
      __setForgeHostsForTests({ 'git.corp.example': 'gitlab', 'github.corp.example': 'github' });
    });
    afterEach(() => {
      __setForgeHostsForTests(null);
    });

    it('accepts https, ssh and scp spellings on a GitLab host and rebuilds a credential-free https URL', () => {
      for (const input of [
        'https://gitlab.com/gitlab-org/cli',
        'https://gitlab.com/gitlab-org/cli.git',
        'https://gitlab.com/gitlab-org/cli/',
        'https://user:glpat-secret@gitlab.com/gitlab-org/cli.git',
        'ssh://git@gitlab.com/gitlab-org/cli.git',
        'git@gitlab.com:gitlab-org/cli.git',
        '  git@gitlab.com:gitlab-org/cli  ',
      ]) {
        expect(parseRepoRef(input), input).toEqual({
          kind: 'gitlab',
          owner: 'gitlab-org',
          repo: 'cli',
          slug: 'gitlab-org/cli',
          cloneUrl: 'https://gitlab.com/gitlab-org/cli.git',
        });
      }
    });

    it('allows subgroups in the source path; the repo (and default folder) is the last segment', () => {
      expect(parseRepoRef('https://gitlab.com/group/sub/deeper/tool.git')).toEqual({
        kind: 'gitlab',
        owner: 'deeper',
        repo: 'tool',
        slug: 'group/sub/deeper/tool',
        cloneUrl: 'https://gitlab.com/group/sub/deeper/tool.git',
      });
      expect(parseRepoRef('git@git.corp.example:platform/infra/deploy.git')).toMatchObject({
        kind: 'gitlab',
        repo: 'deploy',
        slug: 'platform/infra/deploy',
        cloneUrl: 'https://git.corp.example/platform/infra/deploy.git',
      });
      // An http(s) on-prem origin keeps its own scheme and port (D3).
      expect(parseRepoRef('http://git.corp.example:8080/team/app')).toMatchObject({
        kind: 'gitlab',
        cloneUrl: 'http://git.corp.example:8080/team/app.git',
      });
    });

    it('refuses unknown hosts, non-GitLab forge hosts and hostile GitLab paths', () => {
      for (const input of [
        'https://unknown.example/group/repo',
        'git@unknown.example:group/repo.git',
        'https://github.corp.example/owner/repo',
        'https://gitlab.com/solo',
        'https://gitlab.com/group/--upload-pack=touch',
        'https://gitlab.com/group/.hidden',
        'https://gitlab.com/group/repo%2F..',
        'https://gitlab.com/group/repo?x=1',
        'https://gitlab.com/group/repo;rm -rf',
        'gitlab.com/group/repo',
        `https://gitlab.com/${Array.from({ length: 22 }, (_, i) => `g${i}`).join('/')}`,
        // A host with whitespace in it: rejected at the parse, so no malformed origin can reach
        // `cloneUrl` (nor `repoUrl` on the projects route, which parses the same remote).
        'https://gitlab.com /group/repo',
        'https://gitlab.com\t/group/repo',
        'git@git.corp.example :platform/deploy.git',
      ]) {
        expect(parseRepoRef(input), input).toBeNull();
      }
    });

    it('hands glab the rebuilt URL, never the raw input — and the credential helper for the clone itself', () => {
      const ref = parseRepoRef('git@git.corp.example:platform/deploy.git');
      expect(ref).not.toBeNull();
      if (!ref) return;
      // glab does not authenticate `git clone` of a full HTTPS URL (live gitlab.com, glab 1.118):
      // without the `-c` helper a private project fails with "could not read Username".
      expect(glabCloneArgs(ref, '/checkouts/deploy')).toEqual([
        'repo',
        'clone',
        'https://git.corp.example/platform/deploy.git',
        '/checkouts/deploy',
        '--',
        '--progress',
        '-c',
        'credential.https://git.corp.example.helper=',
        '-c',
        'credential.https://git.corp.example.helper=!glab auth git-credential',
      ]);
    });
  });

  it('a folder name is one boring path segment — never a traversal', () => {
    expect(isValidCheckoutName('cezar')).toBe(true);
    expect(isValidCheckoutName('my.repo_2-x')).toBe(true);
    for (const name of ['', '.', '..', '.ssh', 'a/b', 'a\\b', '../escape', '/abs', 'a'.repeat(200)]) {
      expect(isValidCheckoutName(name), name).toBe(false);
    }
  });

});

describe('checkout — GitHub transport', () => {
  it('forces the validated HTTPS URL so a global SSH preference cannot bypass the OAuth grant', () => {
    const ref = parseRepoRef('git@github.com:open-mercato/cezar.git');
    expect(ref).not.toBeNull();
    expect(ghCloneArgs(ref!, '/checkouts/cezar')).toEqual([
      'repo',
      'clone',
      'https://github.com/open-mercato/cezar.git',
      '/checkouts/cezar',
      '--',
      '--progress',
    ]);
  });
});

describe('checkout — persisted GitHub credentials', () => {
  it('leaves HTTPS origin and a local helper usable from task worktrees', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-credentials-'));
    const bin = join(root, 'bin');
    const repo = join(root, 'repo');
    mkdirSync(bin);
    // Substitute only gh: the runner and post-clone git configuration are real.
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\ngit init -q "$4" && git -C "$4" remote add origin "$3"\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    try {
      expect(await ghCloneRunner(parseRepoRef('owner/repo')!, repo, () => {}, undefined)).toEqual({ ok: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      expect(git('remote', 'get-url', 'origin').trim()).toBe('https://github.com/owner/repo.git');
      expect(git('config', '--local', '--get-all', 'credential.https://github.com.helper')).toBe('\n!gh auth git-credential\n');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
      const worktree = join(root, 'task');
      git('worktree', 'add', '-qb', 'task', worktree);
      expect(execFileSync('git', ['-C', worktree, 'config', '--get-all', 'credential.https://github.com.helper'], { encoding: 'utf8' })).toBe('\n!gh auth git-credential\n');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkout — persisted GitLab credentials (4.2-review-fix)', () => {
  /** A fake `glab` that behaves like the real one for this test's purposes: it
   *  clones (`git init` + `remote add`) into the directory `checkoutRepo`
   *  already created, exactly like `ghCloneRunner`'s fake `gh` does above. */
  const FAKE_GLAB = '#!/bin/sh\ngit init -q "$4" && git -C "$4" remote add origin "$3"\n';

  const withFakeGlab = async (
    script: string,
    fn: (root: string, repo: string) => Promise<void>,
  ): Promise<void> => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-glab-credentials-'));
    const bin = join(root, 'bin');
    const repo = join(root, 'repo');
    mkdirSync(bin);
    writeFileSync(join(bin, 'glab'), script, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    try {
      await fn(root, repo);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('leaves a gitlab.com origin and a local helper usable from task worktrees', async () => {
    await withFakeGlab(FAKE_GLAB, async (root, repo) => {
      const ref = parseRepoRef('https://gitlab.com/gitlab-org/cli')!;
      expect(await glabCloneRunner(ref, repo, () => {}, undefined)).toEqual({ ok: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      expect(git('remote', 'get-url', 'origin').trim()).toBe('https://gitlab.com/gitlab-org/cli.git');
      expect(git('config', '--local', '--get-all', 'credential.https://gitlab.com.helper')).toBe('\n!glab auth git-credential\n');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
      const worktree = join(root, 'task');
      git('worktree', 'add', '-qb', 'task', worktree);
      expect(execFileSync('git', ['-C', worktree, 'config', '--get-all', 'credential.https://gitlab.com.helper'], { encoding: 'utf8' })).toBe('\n!glab auth git-credential\n');
    });
  });

  it('authenticates the clone itself: glab gets the helper as git -c flags, and never prompts', async () => {
    // Records glab's argv and the prompt switches it saw, then clones like the fake above.
    const recorder = `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/argv"\nprintf '%s|%s\\n' "$GLAB_NO_PROMPT" "$GIT_TERMINAL_PROMPT" > "$(dirname "$0")/env"\n${FAKE_GLAB.replace('#!/bin/sh\n', '')}`;
    await withFakeGlab(recorder, async (root, repo) => {
      const ref = parseRepoRef('https://gitlab.com/acme/private-app')!;
      expect(await glabCloneRunner(ref, repo, () => {}, undefined)).toEqual({ ok: true });
      const argv = readFileSync(join(root, 'bin', 'argv'), 'utf8').trim().split('\n');
      expect(argv.slice(argv.indexOf('--'))).toEqual([
        '--',
        '--progress',
        '-c',
        'credential.https://gitlab.com.helper=',
        '-c',
        'credential.https://gitlab.com.helper=!glab auth git-credential',
      ]);
      expect(readFileSync(join(root, 'bin', 'env'), 'utf8').trim()).toBe('1|0');
    });
  });

  it('keys the helper on a port-bearing on-prem origin, never a hardcoded host', async () => {
    __setForgeHostsForTests({ 'git.corp.example': 'gitlab' });
    try {
      await withFakeGlab(FAKE_GLAB, async (_root, repo) => {
        const ref = parseRepoRef('http://git.corp.example:8080/team/app')!;
        expect(await glabCloneRunner(ref, repo, () => {}, undefined)).toEqual({ ok: true });
        const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        expect(git('remote', 'get-url', 'origin').trim()).toBe('http://git.corp.example:8080/team/app.git');
        expect(git('config', '--local', '--get-all', 'credential.http://git.corp.example:8080.helper')).toBe('\n!glab auth git-credential\n');
      });
    } finally {
      __setForgeHostsForTests(null);
    }
  });

  it('fails the clone (rather than leave `glab` uncredentialed) when the helper cannot be written', async () => {
    // The clone itself succeeds, but `.git` is then made unwritable — `git
    // config` writes via a lockfile + rename, so it's the DIRECTORY's write
    // permission that has to go, not the file's. Same shape a permissions
    // problem on the checkout root would leave: a real clone, no credential
    // helper.
    await withFakeGlab(`${FAKE_GLAB}chmod 0555 "$4/.git"\n`, async (_root, repo) => {
      const ref = parseRepoRef('https://gitlab.com/gitlab-org/cli')!;
      try {
        expect(await glabCloneRunner(ref, repo, () => {}, undefined)).toEqual({
          ok: false,
          error: 'Could not configure GitLab credentials for the checkout. Check directory permissions and retry.',
        });
      } finally {
        // Restore write access so `withFakeGlab`'s own `rmSync(root, ...)` can
        // remove `.git`'s contents afterwards.
        chmodSync(join(repo, '.git'), 0o755);
      }
    });
  });
});

describe('checkout — the cleanup guard', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-root-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes a direct child of the checkout root, recursively', async () => {
    const target = join(root, 'repo');
    mkdirSync(join(target, '.git', 'objects'), { recursive: true });
    writeFileSync(join(target, 'README.md'), 'x', 'utf8');
    expect(await cleanupCheckout(root, target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    // The root itself survives — it is the operator's checkout root, not ours.
    expect(existsSync(root)).toBe(true);
  });

  it('REFUSES a directory outside the checkout root', async () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-outside-'));
    writeFileSync(join(outside, 'precious.txt'), 'keep me', 'utf8');
    try {
      expect(await cleanupCheckout(root, outside)).toBe(false);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('REFUSES the checkout root itself and anything nested deeper than one level', async () => {
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(await cleanupCheckout(root, root)).toBe(false);
    expect(await cleanupCheckout(root, `${root}/`)).toBe(false);
    expect(await cleanupCheckout(root, nested)).toBe(false);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('REFUSES a symlink, even one that spells as a direct child of the root', async () => {
    // The swap attack: the target we created is replaced by a link to somewhere
    // real. `realpath` alone would resolve it and (if the victim happened to sit
    // under the root) delete it — the lstat check is what stops the class.
    const victim = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-victim-'));
    writeFileSync(join(victim, 'precious.txt'), 'keep me', 'utf8');
    const insideVictim = join(root, 'inside-victim');
    mkdirSync(insideVictim);
    writeFileSync(join(insideVictim, 'precious.txt'), 'keep me', 'utf8');
    const linkOut = join(root, 'repo');
    const linkIn = join(root, 'repo2');
    symlinkSync(victim, linkOut);
    symlinkSync(insideVictim, linkIn);
    try {
      expect(await cleanupCheckout(root, linkOut)).toBe(false);
      expect(await cleanupCheckout(root, linkIn)).toBe(false);
      expect(existsSync(join(victim, 'precious.txt'))).toBe(true);
      expect(existsSync(join(insideVictim, 'precious.txt'))).toBe(true);
    } finally {
      rmSync(victim, { recursive: true, force: true });
    }
  });

  it('REFUSES a path that does not exist, and a file', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, 'x', 'utf8');
    expect(await cleanupCheckout(root, join(root, 'nope'))).toBe(false);
    expect(await cleanupCheckout(root, file)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

describe('checkoutRepo — clone, failure cleanup, existing target', () => {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-'));
    // The `run: undefined` tests exercise the CEZ_DRY_RUN fake clone; without
    // this the default runner shells out to a real `gh repo clone`.
    process.env.CEZ_DRY_RUN = '1';
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const events: unknown[] = [];
  const run = (opts: Partial<Parameters<typeof checkoutRepo>[0]> = {}) => {
    events.length = 0;
    return checkoutRepo({
      url: 'open-mercato/cezar',
      projectsDir: root,
      onProgress: (event) => events.push(event),
      ...opts,
    });
  };

  /** A runner that writes a plausible half-clone and then fails — the shape a
   *  killed `git clone` leaves behind. */
  const failingRunner: CloneRunner = async (_ref, dir, onLine) => {
    onLine('Cloning into ...');
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'index.lock'), '', 'utf8');
    return {
      ok: false,
      error: 'fatal: could not read Username: terminal prompts disabled',
    };
  };

  it('the CEZ_DRY_RUN fake clone lands a repo at <projectsDir>/<repo> and reports done', async () => {
    const result = await run({ run: undefined, checkoutId: 'co-1' });
    expect(result).toMatchObject({
      ok: true,
      name: 'cezar',
      target: join(root, 'cezar'),
    });
    expect(existsSync(join(root, 'cezar', '.git'))).toBe(true);
    expect(readFileSync(join(root, 'cezar', 'README.md'), 'utf8')).toContain('cezar');
    // Progress reached the caller BEFORE the terminal event — the whole reason
    // the stream exists (a silent spinner is the failure mode).
    expect(events.at(-1)).toEqual({
      checkoutId: 'co-1',
      name: 'cezar',
      phase: 'done',
    });
    expect(events.filter((e) => (e as { phase: string }).phase === 'cloning').length).toBeGreaterThan(0);
    expect(events.every((e) => (e as { checkoutId: string }).checkoutId === 'co-1')).toBe(true);
  });

  it('honors an explicit name and refuses a traversing one without touching the disk', async () => {
    expect(await run({ name: 'my-checkout' })).toMatchObject({
      ok: true,
      target: join(root, 'my-checkout'),
    });
    for (const name of ['../escape', 'a/b', '..']) {
      const result = await run({ name });
      expect(result, name).toMatchObject({ ok: false, status: 400 });
    }
    // Only the legitimate one exists; nothing was created next to or above the root.
    expect(existsSync(join(root, 'my-checkout'))).toBe(true);
    expect(existsSync(join(root, '..', 'escape'))).toBe(false);
  });

  it('a FAILED clone is cleaned up, surfaces the error verbatim, and leaves the root empty', async () => {
    const result = await run({ run: failingRunner, checkoutId: 'co-2' });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result).toHaveProperty('error', expect.stringContaining('could not read Username'));
    // THE cleanup assertion: no half-clone survives a failure.
    expect(existsSync(join(root, 'cezar'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ phase: 'error', checkoutId: 'co-2' });
    // …and because it was cleaned up, an immediate retry is a fresh clone
    // rather than the 409 a leftover directory would have produced.
    expect(await run({ checkoutId: 'co-3' })).toMatchObject({ ok: true });
  });

  it('a runner that THROWS is treated as a failed clone — same cleanup', async () => {
    const thrower: CloneRunner = async (_ref, dir) => {
      await mkdir(join(dir, '.git'), { recursive: true });
      throw new Error('socket hang up');
    };
    const result = await run({ run: thrower });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(existsSync(join(root, 'cezar'))).toBe(false);
  });

  it('degrades to { error, reason } + 503 when gh is not installed', async () => {
    const missing: CloneRunner = async () => ({
      ok: false,
      error: 'spawn gh ENOENT',
      notFound: true,
    });
    const result = await run({ run: missing });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(result).toHaveProperty('reason', expect.stringContaining('gh CLI not found'));
    expect(existsSync(join(root, 'cezar'))).toBe(false);
  });

  it('clones a GitLab subgroup source into <projectsDir>/<last segment> via the shared dry run', async () => {
    const seen: string[] = [];
    const spy: CloneRunner = async (ref, dir, onLine) => {
      seen.push(`${ref.kind} ${ref.cloneUrl} ${dir}`);
      onLine('Cloning into ...');
      await mkdir(join(dir, '.git'), { recursive: true });
      return { ok: true };
    };
    const result = await run({ url: 'https://gitlab.com/group/sub/tool.git', run: spy });
    expect(result).toMatchObject({ ok: true, name: 'tool', target: join(root, 'tool') });
    expect(seen).toEqual([`gitlab https://gitlab.com/group/sub/tool.git ${join(root, 'tool')}`]);

    const dry = await run({ url: 'git@gitlab.com:group/sub/other.git', run: undefined });
    expect(dry).toMatchObject({ ok: true, name: 'other' });
    expect(existsSync(join(root, 'other', '.git'))).toBe(true);
  });

  it('400s an unknown forge host with the neutral message and writes nothing', async () => {
    const result = await run({ url: 'https://unknown.example/group/repo' });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'not a git forge repository: https://unknown.example/group/repo',
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('degrades to a glab hint + 503 when glab is not installed for a GitLab source', async () => {
    const missing: CloneRunner = async () => ({
      ok: false,
      error: 'spawn glab ENOENT',
      notFound: true,
    });
    const result = await run({ url: 'https://gitlab.com/gitlab-org/cli', run: missing });
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'glab CLI not found — install the GitLab CLI and run `glab auth login`',
      reason: 'glab CLI not found — install the GitLab CLI and run `glab auth login`',
    });
    expect(existsSync(join(root, 'cli'))).toBe(false);
  });

  it('409s on an existing target and does NOT touch it', async () => {
    const existing = join(root, 'cezar');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'precious.txt'), 'someone else lives here', 'utf8');
    // A runner that would destroy the folder if it were ever reached.
    const forbidden: CloneRunner = async () => {
      throw new Error('the runner must not run when the target exists');
    };
    const result = await run({ run: forbidden });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(join(existing, 'precious.txt'), 'utf8')).toBe('someone else lives here');
    // Not even a progress event: nothing about this attempt started.
    expect(events).toEqual([]);
  });

  it('creates the checkout root on demand — a fresh install has never had one', async () => {
    const fresh = join(root, 'never', 'existed');
    const result = await checkoutRepo({
      url: 'open-mercato/cezar',
      projectsDir: fresh,
      onProgress: () => {},
    });
    expect(result).toMatchObject({ ok: true, target: join(fresh, 'cezar') });
  });
});

describe('POST /api/v1/projects/checkout', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedProjectsDir = process.env.CEZ_PROJECTS_DIR;
  const savedRemote = process.env.CEZ_REMOTE;
  let home: string;
  let repoRoot: string;
  let checkoutRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-boot-'));
    checkoutRoot = join(home, 'cezar', 'projects');
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PROJECTS_DIR;
    delete process.env.CEZ_REMOTE;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedProjectsDir === undefined) delete process.env.CEZ_PROJECTS_DIR;
    else process.env.CEZ_PROJECTS_DIR = savedProjectsDir;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      ...over,
    });

  const post = async (body: unknown, over: Partial<ServerDeps> = {}) => {
    const res = await apiRequest(makeApp(over), '/api/v1/projects/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Partial<RegisterProjectResponse> & { error?: string; reason?: string },
    };
  };

  const listProjectsViaApi = async (): Promise<ProjectsResponse> =>
    (await (await apiRequest(makeApp(), '/api/v1/projects')).json()) as ProjectsResponse;

  /** The REGISTRY rows. The route also lists the unregistered boot folder (it
   *  serves it, so the cockpit must be able to reach it — see projects-api.test.ts);
   *  a checkout assertion is about what the clone did or did not register. */
  const registeredViaApi = async (): Promise<ProjectsResponse['projects']> =>
    (await listProjectsViaApi()).projects.filter((project) => !project.unregistered);

  /** Point the workspace at a temp checkout root, so nothing lands in `~`. */
  const useCheckoutRoot = () =>
    mergeWriteWorkspaceConfig((config) => {
      config.projectsDir = checkoutRoot;
    });

  it('clones into projectsDir, registers the result as source=checkout, and streams progress', async () => {
    await useCheckoutRoot();
    const bus = new WorkspaceEventBus();
    const seen: { event: string; data: unknown }[] = [];
    bus.on((event, data) => seen.push({ event, data }));

    const { status, body } = await post({ url: 'open-mercato/cezar', checkoutId: 'co-9' }, { workspaceEvents: bus });
    expect(status).toBe(200);
    expect(body.project).toMatchObject({
      name: 'cezar',
      source: 'checkout',
      status: 'ok',
    });
    expect(body.project?.root).toBe(join(checkoutRoot, 'cezar'));
    expect(existsSync(join(checkoutRoot, 'cezar', '.git'))).toBe(true);

    // The dialog's two feeds: `checkout-progress` while it runs, `project-added`
    // once at the end (which is what makes every open sidebar grow the group).
    const progress = seen.filter((s) => s.event === 'checkout-progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((s) => (s.data as { checkoutId: string }).checkoutId === 'co-9')).toBe(true);
    expect((progress.at(-1)?.data as { phase: string }).phase).toBe('done');
    expect(seen.filter((s) => s.event === 'project-added')).toEqual([
      { event: 'project-added', data: { project: body.project } },
    ]);

    // Immediately listable — the dialog navigates to `/p/<id>/` and the route
    // gate reads this list to decide the id is known.
    expect((await listProjectsViaApi()).projects.map((p) => p.id)).toContain(body.project?.id);
  });

  it('uses CEZ_PROJECTS_DIR as the zero-config checkout root and creates it recursively', async () => {
    const fromEnv = join(home, 'deep', 'environment', 'checkouts');
    process.env.CEZ_PROJECTS_DIR = fromEnv;
    const { status, body } = await post({ url: 'open-mercato/cezar' });
    expect(status).toBe(200);
    expect(body.project?.root).toBe(join(fromEnv, 'cezar'));
    expect(existsSync(join(fromEnv, 'cezar', '.git'))).toBe(true);
  });

  it('409s when the target folder already exists, leaving it and the registry untouched', async () => {
    await useCheckoutRoot();
    const existing = join(checkoutRoot, 'cezar');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'precious.txt'), 'mine', 'utf8');

    const { status, body } = await post({
      url: 'https://github.com/open-mercato/cezar.git',
    });
    expect(status).toBe(409);
    expect(body.error).toContain('already exists');
    expect(body.project).toBeUndefined();
    expect(readFileSync(join(existing, 'precious.txt'), 'utf8')).toBe('mine');
    expect(await registeredViaApi()).toEqual([]);
  });

  it('surfaces a clone failure as a readable error, cleans up, and registers nothing', async () => {
    await useCheckoutRoot();
    const cloneRunner: CloneRunner = async (_ref, dir, onLine) => {
      onLine('Cloning into ...');
      await mkdir(join(dir, '.git'), { recursive: true });
      return { ok: false, error: 'ERROR: Repository not found.' };
    };
    const bus = new WorkspaceEventBus();
    const seen: { event: string; data: unknown }[] = [];
    bus.on((event, data) => seen.push({ event, data }));

    const { status, body } = await post({ url: 'open-mercato/nope' }, { cloneRunner, workspaceEvents: bus });
    expect(status).toBe(500);
    // Verbatim: gh's own words are the only ones that can tell the user WHY.
    expect(body.error).toContain('Repository not found');
    expect(existsSync(join(checkoutRoot, 'nope'))).toBe(false);
    expect(await registeredViaApi()).toEqual([]);
    expect(seen.some((s) => s.event === 'project-added')).toBe(false);
    expect(seen.at(-1)).toMatchObject({
      event: 'checkout-progress',
      data: { phase: 'error' },
    });
  });

  it('degrades with { error, reason } when gh is unavailable', async () => {
    await useCheckoutRoot();
    const cloneRunner: CloneRunner = async () => ({
      ok: false,
      error: 'spawn gh ENOENT',
      notFound: true,
    });
    const { status, body } = await post({ url: 'open-mercato/cezar' }, { cloneRunner });
    expect(status).toBe(503);
    expect(body.reason).toContain('gh auth login');
    expect(body.error).toBe(body.reason);
  });

  it('clones and registers a GitLab source; a missing glab degrades with its own hint', async () => {
    await useCheckoutRoot();
    const ok = await post({ url: 'https://gitlab.com/group/sub/tool' });
    expect(ok.status).toBe(200);
    expect(ok.body.project).toMatchObject({ name: 'tool', source: 'checkout' });
    expect(ok.body.project?.root).toBe(join(checkoutRoot, 'tool'));

    const cloneRunner: CloneRunner = async () => ({ ok: false, error: 'spawn glab ENOENT', notFound: true });
    const { status, body } = await post({ url: 'git@gitlab.com:group/other.git' }, { cloneRunner });
    expect(status).toBe(503);
    expect(body.reason).toContain('glab auth login');
    expect(body.error).toBe(body.reason);
  });

  it('400s a non-GitHub url, a traversing name, and a malformed body — nothing written', async () => {
    await useCheckoutRoot();
    for (const payload of [
      { url: 'https://bitbucket.org/owner/repo' },
      { url: 'not a repo' },
      { url: 'open-mercato/cezar', name: '../escape' },
      {},
      { url: '  ' },
    ]) {
      const { status, body } = await post(payload);
      expect(status, JSON.stringify(payload)).toBe(400);
      expect(typeof body.error).toBe('string');
    }
    expect(existsSync(join(checkoutRoot, 'escape'))).toBe(false);
    expect(await registeredViaApi()).toEqual([]);
  });

  it('a repo already registered under a DIFFERENT name still clones and registers fresh', async () => {
    // The 409-on-existing-dir path is about the folder, not the repo: two
    // checkouts of the same repo under different names are legitimate.
    await useCheckoutRoot();
    expect((await post({ url: 'open-mercato/cezar', name: 'one' })).status).toBe(200);
    const second = await post({ url: 'open-mercato/cezar', name: 'two' });
    expect(second.status).toBe(200);
    expect((await registeredViaApi()).map((p) => p.name).sort()).toEqual(['one', 'two']);
  });

  it('a checkout that duplicates an ALREADY-registered root answers 409 with the existing entry', async () => {
    // Reachable when the folder was removed from disk but its registry row was
    // not: the clone succeeds, and registration recognises the realpath.
    await useCheckoutRoot();
    mkdirSync(checkoutRoot, { recursive: true });
    const target = join(checkoutRoot, 'cezar');
    mkdirSync(target, { recursive: true });
    const existing = await registerProject(target, 'local');
    rmSync(target, { recursive: true, force: true });
    clearProjectProbeCache();

    const { status, body } = await post({ url: 'open-mercato/cezar' });
    expect(status).toBe(409);
    expect(body.error).toContain(existing.id);
    // The clone is still on disk — a successful checkout is never deleted by a
    // registry outcome, and the message says where it is.
    expect(body.error).toContain(target);
    expect(existsSync(join(target, '.git'))).toBe(true);
  });
});
