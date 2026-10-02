import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetForgeDiscoveryWarningsForTests,
  defaultForgeHostCacheFile,
  parseGhAuthHosts,
  parseGlabAuthHosts,
  readForgeHostCache,
  warmForgeDiscovery,
  WELL_KNOWN_FORGE_HOSTS,
  wellKnownForgeKind,
  writeForgeHostCache,
  type ForgeDiscoveryRunner,
  type ForgeHostMap,
} from './discovery.ts';

/**
 * Tests for spec 2026-08-10-forge-provider-adapters § Forge discovery (Phase 2, Step 2.1). This
 * module is not wired into `forge/index.ts` or boot yet, so every case here exercises the module
 * directly, never through a real `~/.cache/cez/` — a temp directory stands in throughout.
 */

// ---- fixtures -----------------------------------------------------------------------------------
// `gh`/`glab auth status` real output, captured 2026-09-22 (redacted) plus synthetic variants for
// shapes the capture didn't happen to produce.

const GH_LOGGED_IN_ONE_HOST = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
`;

const GLAB_LOGGED_IN_ONE_HOST = `gitlab.com
  ✓ Logged in to gitlab.com as example-user (keyring)
  ✓ Git operations for gitlab.com configured to use ssh protocol.
  ✓ API calls for gitlab.com are made over https protocol.
  ✓ REST API Endpoint: https://gitlab.com/api/v4/
  ✓ GraphQL Endpoint: https://gitlab.com/api/graphql/
  ✓ Token found in operating system keyring: **************************
`;

const GH_MULTIPLE_HOSTS_WITH_ENTERPRISE = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'

ghe.acme.corp
  ✓ Logged in to ghe.acme.corp account alice (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: ghp_************************************
  - Token scopes: 'repo', 'read:org'
`;

const GLAB_MULTIPLE_HOSTS_WITH_SELF_MANAGED = `gitlab.com
  ✓ Logged in to gitlab.com as example-user (keyring)
  ✓ Git operations for gitlab.com configured to use ssh protocol.
  ✓ API calls for gitlab.com are made over https protocol.

gitlab.acme.internal
  ✓ Logged in to gitlab.acme.internal as bob (keyring)
  ✓ Git operations for gitlab.acme.internal configured to use ssh protocol.
  ✓ API calls for gitlab.acme.internal are made over https protocol.
`;

const GH_LOGGED_OUT_HOST = `github.com
  X Failed to log in to github.com using token (GH_TOKEN)
  - The token in GH_TOKEN is invalid.
`;

const GLAB_LOGGED_OUT_HOST = `gitlab.com
  X No token provided for gitlab.com
  - The token in GITLAB_TOKEN is invalid.
`;

/** A CLI that indents everything (or re-words its header): only the detail lines name the host. */
const GH_INDENTED_ONLY = `  ✓ Logged in to ghe.acme.corp account alice (keyring)
  - Active account: true
  - Git operations protocol: https
`;

const GLAB_INDENTED_ONLY = `  ✓ Logged in to gitlab.acme.internal as bob (keyring)
  ✓ API calls for gitlab.acme.internal are made over https protocol.
`;

const GH_NO_HOSTS = `You are not logged into any GitHub hosts. Run gh auth login to authenticate.
`;

const GLAB_NO_HOSTS = `No GitLab hosts configured. Run glab auth login to authenticate.
`;

const GARBAGE_INPUT = `this is not auth status output at all
   some indented junk that is not a host
!!! 4204 nonsense !!!
`;

// ---- WELL_KNOWN_FORGE_HOSTS / wellKnownForgeKind ------------------------------------------------

describe('WELL_KNOWN_FORGE_HOSTS / wellKnownForgeKind', () => {
  it('maps the two well-known SaaS hosts', () => {
    expect(WELL_KNOWN_FORGE_HOSTS['github.com']).toBe('github');
    expect(WELL_KNOWN_FORGE_HOSTS['gitlab.com']).toBe('gitlab');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(wellKnownForgeKind('GitHub.com')).toBe('github');
    expect(wellKnownForgeKind('  gitlab.com  ')).toBe('gitlab');
  });

  it('answers null for an unknown host', () => {
    expect(wellKnownForgeKind('ghe.acme.corp')).toBeNull();
    expect(wellKnownForgeKind('example.com')).toBeNull();
  });
});

// ---- parseGhAuthHosts / parseGlabAuthHosts ------------------------------------------------------

describe('parseGhAuthHosts', () => {
  it('reads the single logged-in host', () => {
    expect(parseGhAuthHosts(GH_LOGGED_IN_ONE_HOST)).toEqual(['github.com']);
  });

  it('reads every host, including a self-managed (GitHub Enterprise) one', () => {
    expect(parseGhAuthHosts(GH_MULTIPLE_HOSTS_WITH_ENTERPRISE)).toEqual(['github.com', 'ghe.acme.corp']);
  });

  it('still counts a logged-out host — an invalid token does not change which forge it is', () => {
    expect(parseGhAuthHosts(GH_LOGGED_OUT_HOST)).toEqual(['github.com']);
  });

  it('answers [] when no host is logged in', () => {
    expect(parseGhAuthHosts(GH_NO_HOSTS)).toEqual([]);
  });

  it('answers [] on garbage input', () => {
    expect(parseGhAuthHosts(GARBAGE_INPUT)).toEqual([]);
  });

  it('lowercases and dedupes', () => {
    expect(parseGhAuthHosts('GitHub.com\n  ✓ Logged in\n\ngithub.com\n  ✓ Logged in\n')).toEqual([
      'github.com',
    ]);
  });

  // The header line is one line of formatting; the rung must not depend on it alone.
  it('reads the host out of an indented `Logged in to` line when no header names it', () => {
    expect(parseGhAuthHosts(GH_INDENTED_ONLY)).toEqual(['ghe.acme.corp']);
  });

  it('dedupes the header against the detail line naming the same host', () => {
    expect(parseGhAuthHosts(GH_LOGGED_IN_ONE_HOST)).toEqual(['github.com']);
  });
});

describe('parseGlabAuthHosts', () => {
  it('reads the single logged-in host', () => {
    expect(parseGlabAuthHosts(GLAB_LOGGED_IN_ONE_HOST)).toEqual(['gitlab.com']);
  });

  it('reads every host, including a self-managed instance', () => {
    expect(parseGlabAuthHosts(GLAB_MULTIPLE_HOSTS_WITH_SELF_MANAGED)).toEqual([
      'gitlab.com',
      'gitlab.acme.internal',
    ]);
  });

  it('still counts a logged-out host', () => {
    expect(parseGlabAuthHosts(GLAB_LOGGED_OUT_HOST)).toEqual(['gitlab.com']);
  });

  it('answers [] when no host is logged in', () => {
    expect(parseGlabAuthHosts(GLAB_NO_HOSTS)).toEqual([]);
  });

  it('answers [] on garbage input', () => {
    expect(parseGlabAuthHosts(GARBAGE_INPUT)).toEqual([]);
  });

  it('reads the host out of an indented `Logged in to` line when no header names it', () => {
    expect(parseGlabAuthHosts(GLAB_INDENTED_ONLY)).toEqual(['gitlab.acme.internal']);
  });
});

// ---- readForgeHostCache / writeForgeHostCache ---------------------------------------------------

describe('forge host cache', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-forge-discovery-'));
    file = join(dir, 'forge-hosts.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaultForgeHostCacheFile never resolves inside a test temp dir (sanity: a real path under ~/.cache/cez)', () => {
    expect(defaultForgeHostCacheFile()).toContain(join('.cache', 'cez', 'forge-hosts.json'));
  });

  it('reads an empty map when the file is absent', () => {
    expect(readForgeHostCache(file)).toEqual({});
  });

  it('reads an empty map when the directory is absent', () => {
    expect(readForgeHostCache(join(dir, 'nested', 'missing', 'forge-hosts.json'))).toEqual({});
  });

  it('reads an empty map on corrupt JSON', () => {
    writeFileSync(file, '{ not json', 'utf8');
    expect(readForgeHostCache(file)).toEqual({});
  });

  it('reads an empty map on the wrong version', () => {
    writeFileSync(file, JSON.stringify({ version: 2, hosts: { 'github.com': 'github' }, updatedAt: 'x' }), 'utf8');
    expect(readForgeHostCache(file)).toEqual({});
  });

  it('reads an empty map on the wrong shape (bad host value)', () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, hosts: { 'github.com': 'bitbucket' }, updatedAt: 'x' }),
      'utf8',
    );
    expect(readForgeHostCache(file)).toEqual({});
  });

  it('round-trips a write through a read', () => {
    const hosts: ForgeHostMap = { 'github.com': 'github', 'gitlab.acme.internal': 'gitlab', 'example.com': 'none' };
    expect(writeForgeHostCache(file, hosts)).toBe(true);
    expect(readForgeHostCache(file)).toEqual(hosts);
  });

  it('writes atomically: no tmp file left behind and the target holds valid JSON', () => {
    writeForgeHostCache(file, { 'github.com': 'github' });
    const entries = readdirSync(dir);
    expect(entries).toEqual(['forge-hosts.json']);
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('lowercases host keys on write and on read', () => {
    writeForgeHostCache(file, { 'GitHub.com': 'github' } as unknown as ForgeHostMap);
    expect(readForgeHostCache(file)).toEqual({ 'github.com': 'github' });
  });

  it('bounds the map at 200 hosts', () => {
    const hosts: ForgeHostMap = {};
    for (let i = 0; i < 250; i++) hosts[`host-${i}.example.com`] = 'github';
    writeForgeHostCache(file, hosts);
    expect(Object.keys(readForgeHostCache(file))).toHaveLength(200);
  });

  it('creates the cache directory when missing', () => {
    const nested = join(dir, 'a', 'b', 'forge-hosts.json');
    expect(writeForgeHostCache(nested, { 'github.com': 'github' })).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  // Root ignores the mode bits, same caveat as agent-tmpdir.test.ts.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a read-only directory makes the write fail silently, and reading still works',
    () => {
      chmodSync(dir, 0o500);
      try {
        expect(writeForgeHostCache(file, { 'github.com': 'github' })).toBe(false);
        expect(readForgeHostCache(file)).toEqual({});
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});

// ---- warmForgeDiscovery --------------------------------------------------------------------------

describe('warmForgeDiscovery', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-forge-discovery-warm-'));
    file = join(dir, 'forge-hosts.json');
    __resetForgeDiscoveryWarningsForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('probes both CLIs and merges their hosts into a fresh cache', async () => {
    const merged = await warmForgeDiscovery({
      cacheFile: file,
      run: async (bin) => {
        if (bin === 'gh') return { stdout: '', stderr: GH_MULTIPLE_HOSTS_WITH_ENTERPRISE };
        if (bin === 'glab') return { stdout: '', stderr: GLAB_LOGGED_IN_ONE_HOST };
        throw new Error(`unexpected bin ${bin}`);
      },
    });
    expect(merged).toEqual({
      'github.com': 'github',
      'ghe.acme.corp': 'github',
      'gitlab.com': 'gitlab',
    });
    expect(readForgeHostCache(file)).toEqual(merged);
  });

  it('skips a missing CLI (notFound) without failing the other probe', async () => {
    const merged = await warmForgeDiscovery({
      cacheFile: file,
      run: async (bin) => {
        if (bin === 'gh') return { stdout: '', stderr: '', notFound: true };
        return { stdout: '', stderr: GLAB_LOGGED_IN_ONE_HOST };
      },
    });
    expect(merged).toEqual({ 'gitlab.com': 'gitlab' });
  });

  it('never throws when the runner itself throws', async () => {
    await expect(
      warmForgeDiscovery({
        cacheFile: file,
        run: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toEqual({});
    expect(readForgeHostCache(file)).toEqual({});
  });

  it('merges onto an existing cache rather than replacing it', async () => {
    writeForgeHostCache(file, { 'example.com': 'none', 'gitlab.acme.internal': 'gitlab' });
    const merged = await warmForgeDiscovery({
      cacheFile: file,
      run: async (bin) => {
        if (bin === 'gh') return { stdout: '', stderr: GH_LOGGED_IN_ONE_HOST };
        return { stdout: '', stderr: '', notFound: true };
      },
    });
    expect(merged).toEqual({
      'example.com': 'none',
      'gitlab.acme.internal': 'gitlab',
      'github.com': 'github',
    });
  });

  // A CLI that ran and named nothing leaves every non-SaaS host of its kind unclassified; without
  // a line about it, a parser that stopped matching looks exactly like a working install.
  it('warns once per process when an installed CLI names no host', async () => {
    const warnings: string[] = [];
    const run: ForgeDiscoveryRunner = async (bin) =>
      bin === 'gh' ? { stdout: '', stderr: GH_NO_HOSTS } : { stdout: '', stderr: GLAB_LOGGED_IN_ONE_HOST };

    expect(await warmForgeDiscovery({ cacheFile: file, run, warn: (m) => warnings.push(m) })).toEqual({
      'gitlab.com': 'gitlab',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('gh auth status');
    // The warm-up repeats every ten minutes; the diagnostic does not.
    await warmForgeDiscovery({ cacheFile: file, run, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });

  it('says nothing for a CLI that is not installed, or for one that names a host', async () => {
    const warnings: string[] = [];
    await warmForgeDiscovery({
      cacheFile: file,
      warn: (m) => warnings.push(m),
      run: async (bin) =>
        bin === 'gh'
          ? { stdout: '', stderr: '', notFound: true }
          : { stdout: '', stderr: GLAB_MULTIPLE_HOSTS_WITH_SELF_MANAGED },
    });
    expect(warnings).toEqual([]);
  });

  it('a host reported by both CLIs is not expected in practice, but glab wins when it runs after gh', async () => {
    // Documents merge order rather than asserting a "correct" answer for an impossible input
    // (no host is ever both a GitHub and a GitLab remote) — FORGE_PROBES runs gh then glab.
    const merged = await warmForgeDiscovery({
      cacheFile: file,
      run: async (bin) => {
        if (bin === 'gh') return { stdout: '', stderr: 'shared.example.com\n  ✓ Logged in\n' };
        return { stdout: '', stderr: 'shared.example.com\n  ✓ Logged in\n' };
      },
    });
    expect(merged['shared.example.com']).toBe('gitlab');
  });
});
