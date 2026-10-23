import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGithubHostsCache } from '../../github-hosts.ts';
import { resetGitlabHostsCache } from '../../gitlab-hosts.ts';
import type { RepoInfo } from '../git.ts';
import {
  __setForgeHostsForTests,
  forgeKindOfHost,
  forgeKindOfRemote,
  forgeWebRoot,
  forgePrDiff,
  forgeRefStatus,
  listForgeChecks,
  listForgeComments,
  listForgeItems,
  NO_FORGE_REASON,
  parseRemote,
  resolveForge,
  searchForgeItems,
} from './index.ts';
import type { ForgeChecksData, ForgeDriver, ForgeItem, ForgePrDiffResult, ForgeRefStatusData } from './types.ts';

// Pass-through spies, so the classification cases below can assert the call path spawns nothing
// and re-reads no file inside the TTL (spec 2026-08-10-forge-provider-adapters § Forge discovery).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) };
});

/** Forge resolution (spec §"Forge-driver seam"): remote host → driver | null. */

const info = (remote?: string): RepoInfo => ({ root: '/repo', branch: 'main', remote });

describe('parseRemote', () => {
  // Every case names host/owner/repo (unchanged meaning: the last two path segments) plus the
  // Step 2.3 additions `path` (full project path, `.git` stripped) and `origin` (web origin, D3:
  // http(s) keeps its own scheme+port, every other transport maps to plain https with no port).
  it.each([
    ['https://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['https://github.com/acme/demo', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['https://user:token@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['git@github.com:acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['ssh://git@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['ssh://git@github.com:2222/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['git://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['https://GitHub.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['https://github.com/acme/demo/', { host: 'github.com', owner: 'acme', repo: 'demo', path: 'acme/demo', origin: 'https://github.com' }],
    ['git@gitlab.com:group/sub/project.git', { host: 'gitlab.com', owner: 'sub', repo: 'project', path: 'group/sub/project', origin: 'https://gitlab.com' }],
    // GitLab and on-prem cases (Step 2.3): subgroups, scp-form, ssh:// with a port (dropped),
    // http:// with a port (kept), a non-root instance path, and credentials never leaking out.
    ['https://gitlab.com/group/repo.git', { host: 'gitlab.com', owner: 'group', repo: 'repo', path: 'group/repo', origin: 'https://gitlab.com' }],
    ['https://gitlab.com/group/sub/repo', { host: 'gitlab.com', owner: 'sub', repo: 'repo', path: 'group/sub/repo', origin: 'https://gitlab.com' }],
    ['https://gitlab.com/a/b/c/repo.git', { host: 'gitlab.com', owner: 'c', repo: 'repo', path: 'a/b/c/repo', origin: 'https://gitlab.com' }],
    ['git@gitlab.acme.internal:group/sub/repo.git', { host: 'gitlab.acme.internal', owner: 'sub', repo: 'repo', path: 'group/sub/repo', origin: 'https://gitlab.acme.internal' }],
    ['ssh://git@gitlab.acme.internal:2222/group/repo.git', { host: 'gitlab.acme.internal', owner: 'group', repo: 'repo', path: 'group/repo', origin: 'https://gitlab.acme.internal' }],
    ['http://gitlab.acme.internal:8929/group/repo', { host: 'gitlab.acme.internal', owner: 'group', repo: 'repo', path: 'group/repo', origin: 'http://gitlab.acme.internal:8929' }],
    ['https://intranet/gitlab/group/repo', { host: 'intranet', owner: 'group', repo: 'repo', path: 'gitlab/group/repo', origin: 'https://intranet' }],
    ['https://user:tok@github.com/o/r.git', { host: 'github.com', owner: 'o', repo: 'r', path: 'o/r', origin: 'https://github.com' }],
    ['https://gitlab.com/group/repo/', { host: 'gitlab.com', owner: 'group', repo: 'repo', path: 'group/repo', origin: 'https://gitlab.com' }],
  ])('parses %s', (remote, expected) => {
    expect(parseRemote(remote)).toEqual(expected);
  });

  it('never leaks credentials into path or origin', () => {
    const parsed = parseRemote('https://user:tok@github.com/o/r.git');
    expect(JSON.stringify(parsed)).not.toMatch(/user|tok/);
  });

  it.each([
    ['/srv/git/demo.git'], // local bare path — not a forge
    ['../relative/path'],
    ['https://github.com/only-owner'],
    [''],
  ])('rejects %s', (remote) => {
    expect(parseRemote(remote)).toBeNull();
  });

  // The host patterns capture `[^/:]+`, which admits whitespace; classification trims, but `host`
  // and `origin` kept the raw bytes, so a malformed origin reached `repoUrl` and checkout.
  it.each([
    ['https://gitlab.com /group/repo'],
    ['https://gitlab.com\t/group/repo'],
    ['https://gitlab.com\n/group/repo'],
    ['git@gitlab.com :group/repo.git'],
    ['https://git lab.com/group/repo'],
    ['https://gitlab_com/group/repo'], // underscore: not a DNS label
    ['https://-gitlab.com/group/repo'], // a label may not start with a hyphen
    ['http://[::1]:8929/group/repo'], // no IPv6 literal
  ])('rejects the malformed host in %j', (remote) => {
    expect(parseRemote(remote)).toBeNull();
  });
});

describe('forgeWebRoot with path/origin (Step 2.3)', () => {
  afterEach(() => __setForgeHostsForTests(null));

  it.each([
    ['https://gitlab.com/group/repo.git', 'https://gitlab.com/group/repo'],
    ['https://gitlab.com/group/sub/repo', 'https://gitlab.com/group/sub/repo'],
    ['https://gitlab.com/a/b/c/repo.git', 'https://gitlab.com/a/b/c/repo'],
    ['https://user:tok@github.com/o/r.git', 'https://github.com/o/r'],
    ['https://gitlab.com/group/repo/', 'https://gitlab.com/group/repo'],
  ])('builds %s → %s from well-known hosts alone', (remote, expected) => {
    expect(forgeWebRoot(remote)).toBe(expected);
  });

  it('a remote with a malformed host yields no web root, so `repoUrl` is simply absent', () => {
    expect(forgeWebRoot('https://gitlab.com /group/repo')).toBeNull();
  });

  it('scp-form on-prem GitLab remote: origin has no port', () => {
    __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
    expect(forgeWebRoot('git@gitlab.acme.internal:group/sub/repo.git')).toBe('https://gitlab.acme.internal/group/sub/repo');
  });

  it('ssh:// on-prem GitLab remote with a port: the port never reaches the web origin', () => {
    __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
    expect(forgeWebRoot('ssh://git@gitlab.acme.internal:2222/group/repo.git')).toBe('https://gitlab.acme.internal/group/repo');
  });

  it('http:// on-prem GitLab remote with a port: the port IS the web origin', () => {
    __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
    expect(forgeWebRoot('http://gitlab.acme.internal:8929/group/repo')).toBe('http://gitlab.acme.internal:8929/group/repo');
  });

  it('non-root https instance: the instance prefix rides along as part of path', () => {
    __setForgeHostsForTests({ intranet: 'gitlab' });
    expect(forgeWebRoot('https://intranet/gitlab/group/repo')).toBe('https://intranet/gitlab/group/repo');
  });
});

describe('forgeKindOfRemote', () => {
  // The registry probe's classification (#698) — same host table as resolveForge,
  // but string-only: no driver, no repo root, no `gh`.
  it.each([
    ['https://github.com/acme/demo.git', 'github'],
    ['git@github.com:acme/demo.git', 'github'],
    ['git@gitlab.com:acme/demo.git', 'gitlab'], // well-known, with no glab config at all
    ['https://git.example.com/acme/demo.git', null],
    ['/srv/git/demo.git', null],
    [undefined, null],
  ])('classifies %s as %s', (remote, expected) => {
    expect(forgeKindOfRemote(remote)).toBe(expected);
  });
});

describe('resolveForge', () => {
  it('maps a github.com https remote to the GitHub driver', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'))?.kind).toBe('github');
  });

  it('maps a github.com scp-like remote to the GitHub driver', () => {
    expect(resolveForge(info('git@github.com:acme/demo.git'))?.kind).toBe('github');
  });

  it('maps a gitlab.com remote to the GitLab driver', () => {
    expect(resolveForge(info('git@gitlab.com:acme/demo.git'))?.kind).toBe('gitlab');
    expect(resolveForge(info('https://gitlab.com/group/sub/demo.git'))?.kind).toBe('gitlab');
  });

  it('returns null for a self-hosted host', () => {
    expect(resolveForge(info('https://git.example.com/acme/demo.git'))).toBeNull();
  });

  it('returns null when the repo has no remote', () => {
    expect(resolveForge(info(undefined))).toBeNull();
  });

  it('returns null when not in a git repo at all', () => {
    expect(resolveForge(null)).toBeNull();
  });

  it('returns null for a local-path remote', () => {
    expect(resolveForge(info('/srv/git/demo.git'))).toBeNull();
  });
});

describe('host classification', () => {
  // Spec 2026-08-10-forge-provider-adapters § Forge discovery: well-known hosts, then the hosts
  // each forge CLI already lists in its own config — the only thing an on-prem host can be
  // classified from.
  afterEach(() => __setForgeHostsForTests(null));

  it('builds the GitLab driver for an on-prem gitlab host', () => {
    __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
    const remote = 'git@gitlab.acme.internal:platform/api.git';
    expect(forgeKindOfRemote(remote)).toBe('gitlab');
    expect(forgeWebRoot(remote)).toBe('https://gitlab.acme.internal/platform/api');
    expect(resolveForge(info(remote))?.kind).toBe('gitlab');
  });

  it('builds the GitHub driver for a GitHub Enterprise host', () => {
    __setForgeHostsForTests({ 'github.acme.internal': 'github' });
    const remote = 'https://github.acme.internal/platform/api.git';
    expect(forgeKindOfRemote(remote)).toBe('github');
    expect(forgeWebRoot(remote)).toBe('https://github.acme.internal/platform/api');
    expect(resolveForge(info(remote))?.kind).toBe('github');
  });

  it('answers null for an unknown host', () => {
    __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
    const remote = 'git@git.other.internal:platform/api.git';
    expect(forgeKindOfRemote(remote)).toBeNull();
    expect(forgeWebRoot(remote)).toBeNull();
    expect(resolveForge(info(remote))).toBeNull();
  });

  it('keeps the well-known hosts with nothing configured, case-insensitively', () => {
    expect(forgeKindOfHost('GitLab.com')).toBe('gitlab');
    expect(forgeKindOfHost('github.com')).toBe('github');
    expect(forgeKindOfHost(' gitlab.com ')).toBe('gitlab');
  });

  describe("from the CLIs' own config files", () => {
    let ghDir: string;
    let glabDir: string;
    const saved = { gh: process.env.GH_CONFIG_DIR, glab: process.env.GLAB_CONFIG_DIR };
    beforeEach(() => {
      ghDir = mkdtempSync(join(tmpdir(), 'cez-gh-'));
      glabDir = mkdtempSync(join(tmpdir(), 'cez-glab-'));
      process.env.GH_CONFIG_DIR = ghDir;
      process.env.GLAB_CONFIG_DIR = glabDir;
      resetGithubHostsCache();
      resetGitlabHostsCache();
      vi.mocked(fs.readFileSync).mockClear();
      vi.mocked(childProcess.execFile).mockClear();
      vi.mocked(childProcess.spawn).mockClear();
    });
    afterEach(() => {
      rmSync(ghDir, { recursive: true, force: true });
      rmSync(glabDir, { recursive: true, force: true });
      process.env.GH_CONFIG_DIR = saved.gh;
      process.env.GLAB_CONFIG_DIR = saved.glab;
      resetGithubHostsCache();
      resetGitlabHostsCache();
    });

    const glabConfig = (hosts: string[]): void =>
      writeFileSync(
        join(glabDir, 'config.yml'),
        `git_protocol: ssh\nhost: gitlab.com\nhosts:\n${hosts.map((h) => `    ${h}:\n        api_protocol: https\n        user: me\n`).join('')}`,
      );

    it('classifies a self-managed GitLab host glab is configured for, and nothing else', () => {
      const remote = 'git@gitlab.acme.internal:platform/api.git';
      expect(forgeKindOfRemote(remote)).toBeNull();
      glabConfig(['gitlab.com', 'gitlab.acme.internal']);
      resetGitlabHostsCache();
      expect(forgeKindOfRemote(remote)).toBe('gitlab');
      expect(resolveForge(info(remote))?.kind).toBe('gitlab');
      expect(forgeKindOfRemote('git@git.other.internal:platform/api.git')).toBeNull();
    });

    it('classifies GitHub and GitLab hosts by the same mechanism, side by side', () => {
      writeFileSync(join(ghDir, 'hosts.yml'), 'github.com:\n    user: me\nghe.acme.corp:\n    user: me\n');
      glabConfig(['gitlab.acme.internal']);
      expect(forgeKindOfHost('ghe.acme.corp')).toBe('github');
      expect(forgeKindOfHost('gitlab.acme.internal')).toBe('gitlab');
    });

    it('honors GITLAB_HOST, as a bare host or a URL', () => {
      process.env.GITLAB_HOST = 'https://gitlab.acme.internal:8443/';
      try {
        expect(forgeKindOfHost('gitlab.acme.internal')).toBe('gitlab');
      } finally {
        delete process.env.GITLAB_HOST;
        resetGitlabHostsCache();
      }
    });

    it('spawns nothing, and re-reads no file inside the TTL', () => {
      glabConfig(['gitlab.acme.internal']);
      expect(forgeKindOfRemote('git@gitlab.acme.internal:platform/api.git')).toBe('gitlab');
      vi.mocked(fs.readFileSync).mockClear();
      for (let i = 0; i < 5; i++) {
        forgeKindOfRemote('git@gitlab.acme.internal:platform/api.git');
        forgeKindOfRemote('https://github.com/acme/demo.git');
        forgeWebRoot('git@git.other.internal:platform/api.git');
      }
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('treats a missing or garbled glab config as "gitlab.com only"', () => {
      expect(forgeKindOfHost('gitlab.acme.internal')).toBeNull();
      writeFileSync(join(glabDir, 'config.yml'), '{not: [yaml');
      resetGitlabHostsCache();
      expect(forgeKindOfHost('gitlab.acme.internal')).toBeNull();
      expect(forgeKindOfHost('gitlab.com')).toBe('gitlab');
    });
  });
});

describe('GitHub driver viewUrl', () => {
  const driver = resolveForge(info('git@github.com:acme/demo.git'))!;

  it.each([
    ['repo', 'x', 'https://github.com/acme/demo'],
    ['issue', 142, 'https://github.com/acme/demo/issues/142'],
    ['pr', 128, 'https://github.com/acme/demo/pull/128'],
    ['branch', 'feat/cockpit ui', 'https://github.com/acme/demo/tree/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://github.com/acme/demo/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });
});

describe('GitHub driver viewUrl for a GitHub Enterprise host (Step 2.4)', () => {
  // The driver's viewUrl base now comes from the parsed remote's own origin, not a
  // `https://github.com` literal, so an enterprise host's links resolve to the enterprise host.
  afterEach(() => __setForgeHostsForTests(null));

  const driver = () => {
    __setForgeHostsForTests({ 'ghe.acme.corp': 'github' });
    return resolveForge(info('git@ghe.acme.corp:o/r.git'))!;
  };

  it.each([
    ['repo', 'x', 'https://ghe.acme.corp/o/r'],
    ['issue', 142, 'https://ghe.acme.corp/o/r/issues/142'],
    ['pr', 5, 'https://ghe.acme.corp/o/r/pull/5'],
    ['branch', 'feat/cockpit ui', 'https://ghe.acme.corp/o/r/tree/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://ghe.acme.corp/o/r/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver().viewUrl(kind, ref)).toBe(expected);
  });
});

describe('GitLab driver viewUrl (Step 3.7)', () => {
  const driver = resolveForge(info('git@gitlab.com:acme/demo.git'))!;

  it.each([
    ['repo', 'x', 'https://gitlab.com/acme/demo'],
    ['issue', 142, 'https://gitlab.com/acme/demo/-/issues/142'],
    ['pr', 128, 'https://gitlab.com/acme/demo/-/merge_requests/128'],
    ['branch', 'feat/cockpit ui', 'https://gitlab.com/acme/demo/-/tree/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://gitlab.com/acme/demo/-/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });
});

describe('ForgeDriver optional capabilities', () => {
  // Type-level (spec 2026-08-10-forge-provider-adapters § Driver interface changes): a driver
  // implementing only the required members must compile — every capability beyond them
  // (search, merge, diff, comments, checks, ref status) is optional, and routes degrade in-payload.
  const minimal: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: false, reason: 'test' }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('allows omitting every optional method', () => {
    expect(minimal.searchItems).toBeUndefined();
    expect(minimal.prMergeState).toBeUndefined();
    expect(minimal.mergePR).toBeUndefined();
    expect(minimal.prDiff).toBeUndefined();
    expect(minimal.listComments).toBeUndefined();
    expect(minimal.listChecks).toBeUndefined();
    expect(minimal.refStatus).toBeUndefined();
    expect(minimal.listAll).toBeUndefined();
  });

  it('classifies a gitlab remote and resolves the GitLab driver for it', () => {
    expect(forgeKindOfRemote('git@gitlab.com:acme/demo.git')).toBe('gitlab');
    expect(resolveForge(info('git@gitlab.com:acme/demo.git'))?.kind).toBe('gitlab');
  });
});

describe('listForgeItems / searchForgeItems (the /github and /github/search routes)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.4: both routes go through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const item = (kind: 'issue' | 'pr', number: number): ForgeItem => ({
    kind,
    number,
    title: `#${number}`,
    author: 'someone',
    createdAt: '2026-01-01T00:00:00Z',
    labels: [],
    body: '',
    url: `https://forge.example/${number}`,
    comments: 0,
  });
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [item('issue', 1)],
    listPRs: async () => [item('pr', 2)],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payloads for a null forge', async () => {
    expect(await listForgeItems(null, {})).toEqual({ available: false, reason: NO_FORGE_REASON, issues: [], prs: [] });
    expect(await searchForgeItems(null, 'pr', '1', {})).toEqual({ available: false, reason: NO_FORGE_REASON, items: [] });
  });

  it('serves listAll verbatim and passes the options through', async () => {
    const seen: unknown[] = [];
    const payload = { available: true, repo: 'acme/demo', issues: [], prs: [], labelColors: { bug: 'd73a4a' } };
    const driver: ForgeDriver = { ...base, listAll: async (opts) => (seen.push(opts), payload) };
    expect(await listForgeItems(driver, { refresh: true, limit: 5 })).toBe(payload);
    expect(seen).toEqual([{ refresh: true, limit: 5 }]);
  });

  it('lists a driver without listAll through listIssues + listPRs', async () => {
    const data = await listForgeItems(base, { limit: 5 });
    expect(data).toMatchObject({ available: true, issues: [item('issue', 1)], prs: [item('pr', 2)] });
    expect(data.labelColors).toBeUndefined();
  });

  it('degrades a failing fallback listing instead of throwing', async () => {
    const driver: ForgeDriver = {
      ...base,
      listPRs: async () => {
        throw new Error('glab: 401 Unauthorized\nmore detail');
      },
    };
    expect(await listForgeItems(driver, {})).toEqual({
      available: false,
      reason: 'glab: 401 Unauthorized',
      issues: [],
      prs: [],
    });
  });

  it('degrades search for a driver without searchItems', async () => {
    expect(await searchForgeItems(base, 'issue', 'login', {})).toEqual({
      available: false,
      reason: 'Search is not supported for this gitlab remote',
      items: [],
    });
  });

  it('delegates search to searchItems with the limit', async () => {
    const calls: unknown[] = [];
    const driver: ForgeDriver = {
      ...base,
      searchItems: async (kind, query, opts) => (calls.push([kind, query, opts]), { available: true, items: [] }),
    };
    expect(await searchForgeItems(driver, 'pr', 'fix', { limit: 7 })).toEqual({ available: true, items: [] });
    expect(calls).toEqual([['pr', 'fix', { limit: 7 }]]);
  });
});

describe('listForgeComments (the /github/comments route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.5: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    expect(await listForgeComments(null, 'issue', 1, {})).toEqual({
      available: false,
      reason: NO_FORGE_REASON,
      comments: [],
    });
  });

  it('degrades for a driver without listComments', async () => {
    expect(await listForgeComments(base, 'pr', 137, {})).toEqual({
      available: false,
      reason: 'Comments are not supported for this gitlab remote',
      comments: [],
    });
  });

  it('delegates to listComments with the kind, number and options', async () => {
    const calls: unknown[] = [];
    const payload = { available: true, comments: [] };
    const driver: ForgeDriver = {
      ...base,
      listComments: async (kind, number, opts) => (calls.push([kind, number, opts]), payload),
    };
    expect(await listForgeComments(driver, 'pr', 137, { refresh: true })).toBe(payload);
    expect(calls).toEqual([['pr', 137, { refresh: true }]]);
  });
});

describe('listForgeChecks (the /github/checks route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.6: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    // ForgeChecksData's unavailable branch carries only `reason` — no `checks` field to empty.
    expect(await listForgeChecks(null, [1])).toEqual({
      available: false,
      reason: NO_FORGE_REASON,
    });
  });

  it('degrades for a driver without listChecks', async () => {
    expect(await listForgeChecks(base, [1])).toEqual({
      available: false,
      reason: 'CI checks are not supported for this gitlab remote',
    });
  });

  it('delegates to listChecks with the numbers', async () => {
    const calls: unknown[] = [];
    const payload: ForgeChecksData = { available: true, checks: { 1: 'passing' } };
    const driver: ForgeDriver = {
      ...base,
      listChecks: async (numbers) => (calls.push(numbers), payload),
    };
    expect(await listForgeChecks(driver, [1, 2])).toBe(payload);
    expect(calls).toEqual([[1, 2]]);
  });
});

describe('forgeRefStatus (the /github/ref-status route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.7: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    // A forge that cannot answer at all has nothing to recheck.
    expect(await forgeRefStatus(null, [1], [2])).toEqual({
      available: false,
      reason: NO_FORGE_REASON,
      recheckAfterMs: null,
    });
  });

  it('degrades for a driver without refStatus', async () => {
    expect(await forgeRefStatus(base, [1], [])).toEqual({
      available: false,
      reason: 'Reference status is not supported for this gitlab remote',
      recheckAfterMs: null,
    });
  });

  it('delegates to refStatus with the prs and issues lists', async () => {
    const calls: unknown[] = [];
    const payload: ForgeRefStatusData = { available: true, prs: {}, issues: {}, recheckAfterMs: null };
    const driver: ForgeDriver = {
      ...base,
      refStatus: async (prs, issues) => (calls.push([prs, issues]), payload),
    };
    expect(await forgeRefStatus(driver, [1, 2], [3])).toBe(payload);
    expect(calls).toEqual([[[1, 2], [3]]]);
  });
});

describe('forgePrDiff (the /github/prs/:number/changes route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.8: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    expect(await forgePrDiff(null, 1, {})).toEqual({ available: false, reason: NO_FORGE_REASON });
  });

  it('degrades for a driver without prDiff', async () => {
    expect(await forgePrDiff(base, 1, {})).toEqual({
      available: false,
      reason: 'Pull request changes are not supported for this gitlab remote',
    });
  });

  it('delegates to prDiff with the number and options', async () => {
    const calls: unknown[] = [];
    const payload: ForgePrDiffResult = {
      available: true,
      number: 1,
      headSha: 'a'.repeat(40),
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    };
    const driver: ForgeDriver = {
      ...base,
      prDiff: async (number, opts) => (calls.push([number, opts]), payload),
    };
    expect(await forgePrDiff(driver, 1, { refresh: true })).toBe(payload);
    expect(calls).toEqual([[1, { refresh: true }]]);
  });

  it('lets a driver rejection propagate — the route needs it to map 404s', async () => {
    class NotFound extends Error {}
    const driver: ForgeDriver = {
      ...base,
      prDiff: async () => { throw new NotFound('nope'); },
    };
    await expect(forgePrDiff(driver, 1, {})).rejects.toBeInstanceOf(NotFound);
  });
});

describe('GitHub Enterprise', () => {
  let configDir: string;
  const savedConfigDir = process.env.GH_CONFIG_DIR;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'cez-ghe-'));
    process.env.GH_CONFIG_DIR = configDir;
    resetGithubHostsCache();
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    process.env.GH_CONFIG_DIR = savedConfigDir;
    resetGithubHostsCache();
  });

  it.each([
    'https://company.ghe.com/acme/demo.git',
    'git@acme.ghe.com:acme/widgets.git',
  ])('recognizes %s without any gh config', (remote) => {
    expect(forgeKindOfRemote(remote)).toBe('github');
    expect(resolveForge(info(remote))?.kind).toBe('github');
  });

  it.each([
    'git@github.company.com:acme/demo.git',
    'https://github.internal/o/r',
  ])('does not guess GitHub from a github.* name without a login (%s)', (remote) => {
    expect(forgeKindOfRemote(remote)).toBeNull();
  });

  it('recognizes any host gh is signed in to, on any domain', () => {
    const remote = 'git@code.corp.example:acme/demo.git';
    expect(forgeKindOfRemote(remote)).toBeNull();
    writeFileSync(join(configDir, 'hosts.yml'), 'github.com:\n    user: me\ncode.corp.example:\n    user: me\n    oauth_token: x\n');
    resetGithubHostsCache();
    expect(forgeKindOfRemote(remote)).toBe('github');
    expect(forgeKindOfRemote('git@other.example:acme/demo.git')).toBeNull();
  });

  it('honors GH_HOST', () => {
    process.env.GH_HOST = 'code.corp.example';
    try {
      expect(forgeKindOfRemote('git@code.corp.example:acme/demo.git')).toBe('github');
    } finally {
      delete process.env.GH_HOST;
    }
  });

  it('builds web root and view URLs on the enterprise host', () => {
    const remote = 'https://user:token@company.ghe.com/acme/demo.git';
    expect(forgeWebRoot(remote)).toBe('https://company.ghe.com/acme/demo');
    const driver = resolveForge(info(remote))!;
    expect(driver.viewUrl('pr', 7)).toBe('https://company.ghe.com/acme/demo/pull/7');
    expect(driver.viewUrl('issue', 3)).toBe('https://company.ghe.com/acme/demo/issues/3');
  });
});
