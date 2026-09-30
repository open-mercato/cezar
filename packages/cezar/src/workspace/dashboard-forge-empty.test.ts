import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../server/forge/github.ts', () => ({
  createGithubDriver: () => ({
    recentCreated: async () => ({ available: true, items: [{
      number: 1, title: 'Existing issue', url: 'https://github.com/o/r/issues/1',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    }] }),
  }),
}));
let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'cez-dashboard-git-'));
  vi.stubEnv('GIT_CEILING_DIRECTORIES', dirname(root));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function read() {
  const { getDashboardGithub } = await import('./dashboard-forge.ts');
  return getDashboardGithub([{ id: 'fresh', root }], Date.now());
}

it.each(['folder', 'unborn', 'committed'])('treats a fresh %s without a remote as unconfigured', async (kind) => {
  if (kind !== 'folder') git('init', '-q', '-b', 'main');
  if (kind === 'committed')
    git('-c', 'user.name=Test', '-c', 'user.email=t@test', 'commit', '--allow-empty', '-qm', 'init');
  const result = await read();
  expect(result.rows).toEqual([]);
  expect(result.sources).toHaveLength(2);
  expect(result.sources.every((source) => source.reason === 'No GitHub remote')).toBe(true);
});

it('discovers a configured GitHub remote before the first commit', async () => {
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/o/r');
  const result = await read();
  expect(result.rows).toHaveLength(2);
  expect(result.sources.every((source) => source.state === 'ready')).toBe(true);
});

it('does not disguise a missing project root as no remote', async () => {
  rmSync(root, { recursive: true });
  expect((await read()).sources.every((source) => source.reason === 'Could not read GitHub repository')).toBe(true);
});

it.each(['file', 'directory'])('does not disguise broken Git metadata (%s) as no remote', async (kind) => {
  if (kind === 'file') writeFileSync(join(root, '.git'), 'gitdir: /nonexistent/cez-dashboard-git');
  else mkdirSync(join(root, '.git'));
  expect((await read()).sources.every((source) => source.reason === 'Could not read GitHub repository')).toBe(true);
});

it('retains known repository rows as stale when the project disappears', async () => {
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=t@test', 'commit', '--allow-empty', '-qm', 'init');
  git('remote', 'add', 'origin', 'https://github.com/o/r');
  const initial = await read();
  expect(initial.rows).toHaveLength(2);
  rmSync(root, { recursive: true });
  const unavailable = await read();
  expect(unavailable.rows).toEqual(initial.rows);
  expect(unavailable.sources.every((source) => source.state === 'stale')).toBe(true);
});

// Linux tmpfs provides a real discovery boundary without mounting anything.
it.skipIf(!existsSync('/dev/shm') || statSync('/dev/shm').dev === statSync('/dev').dev)(
  'treats a non-repository at a filesystem discovery boundary as unconfigured', async () => {
    rmSync(root, { recursive: true });
    root = mkdtempSync('/dev/shm/cez-dashboard-git-');
    vi.stubEnv('GIT_CEILING_DIRECTORIES', '');
    vi.stubEnv('GIT_DISCOVERY_ACROSS_FILESYSTEM', '0');
    const result = await read();
    expect(result.rows).toEqual([]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.reason === 'No GitHub remote')).toBe(true);
  },
);
