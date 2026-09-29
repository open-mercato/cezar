import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRepoInfo } from '../server/git.ts';

// Keep repository discovery real; replace only the external GitHub request.
vi.mock('../server/forge/github.ts', () => ({
  createGithubDriver: () => ({
    recentCreated: async () => ({
      available: true,
      items: [{ number: 1, title: 'Known item', createdAt: new Date().toISOString(),
        url: 'https://github.com/o/r/issues/1' }],
    }),
  }),
}));

let root: string;
let realGit: string;
let originalPath: string;
function git(...args: string[]): string {
  return execFileSync(realGit, args, { cwd: root, encoding: 'utf8' });
}
function failRemoteReads(mode: 'all' | 'url'): void {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = remote ]${mode === 'url' ? ' && [ "$2" = get-url ]' : ''}; then
  echo 'fatal: remote read failed' >&2
  exit 128
fi
exec ${quotedGit} "$@"
`, { mode: 0o700 });
  vi.stubEnv('PATH', `${bin}${delimiter}${originalPath}`);
}
// The failure fixture requires `which` and an executable POSIX shell wrapper.
describe.skipIf(process.platform === 'win32')('dashboard Git remote read failures', () => {
  beforeEach(() => {
    vi.resetModules();
    originalPath = process.env.PATH!;
    realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    root = mkdtempSync(join(tmpdir(), 'cez-dashboard-git-'));
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'commit', '--allow-empty', '-q', '-m', 'init');
    git('remote', 'add', 'origin', 'https://github.com/o/r.git');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['all', 'url'] as const)(
    'retains known rows as stale when real Git remote %s reads fail and recovers', async (mode) => {
      const { getDashboardGithub: get } = await import('./dashboard-forge.ts');
      const projects = [{ id: 'p', root }];
      const warm = await get(projects, Date.now() + 1_000);
      expect(warm.rows).toHaveLength(2);
      expect(warm.sources.every((source) => source.state === 'ready')).toBe(true);
      failRemoteReads(mode);
      // Existing callers still get useful root/branch data on a remote-read failure.
      expect(await getRepoInfo(root)).toEqual({ root, branch: 'main', remote: undefined });
      const failed = await get(projects, Date.now() + 2_000);
      expect(failed.rows).toEqual(warm.rows);
      expect(failed.sources).toEqual(warm.sources.map((source) => ({
        ...source, state: 'stale', reason: 'Could not read GitHub repository',
      })));
      vi.stubEnv('PATH', originalPath);
      const recovered = await get(projects, Date.now() + 3_000);
      expect(recovered.rows).toEqual(warm.rows);
      expect(recovered.sources.every((source) => source.state === 'ready')).toBe(true);
    },
  );

  it('reports a cold remote-read failure as unavailable rather than no remote', async () => {
    failRemoteReads('all');
    const { getDashboardGithub: get } = await import('./dashboard-forge.ts');
    const result = await get([{ id: 'p', root }], Date.now());
    expect(result.rows).toEqual([]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.state === 'unavailable'
      && source.reason === 'Could not read GitHub repository')).toBe(true);
  });

  it('forgets cached rows after confirmed remote removal, including a later read failure', async () => {
    const { getDashboardGithub: get } = await import('./dashboard-forge.ts');
    const projects = [{ id: 'p', root }];
    expect((await get(projects, Date.now() + 1_000)).rows).toHaveLength(2);
    git('remote', 'remove', 'origin');
    const removed = await get(projects, Date.now() + 2_000);
    expect(removed.rows).toEqual([]);
    expect(removed.sources.every((source) => source.reason === 'No GitHub remote')).toBe(true);
    failRemoteReads('all');
    const failed = await get(projects, Date.now() + 3_000);
    expect(failed.rows).toEqual([]);
    expect(failed.sources.every((source) => source.state === 'unavailable'
      && source.reason === 'Could not read GitHub repository')).toBe(true);
  });
});
