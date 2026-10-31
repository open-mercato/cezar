import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { suggestRepositories } from './repo-suggestions.ts';

/** `GET /api/v1/fs/repos` (spec 2026-10-26-first-run-onboarding) — the first-run project list. */
describe('suggestRepositories', () => {
  let home: string;
  let claudeStateFile: string;

  const repo = (...segments: string[]): string => {
    const dir = join(home, ...segments);
    mkdirSync(join(dir, '.git'), { recursive: true });
    return dir;
  };
  const history = (...paths: string[]): void => {
    writeFileSync(claudeStateFile, JSON.stringify({ projects: Object.fromEntries(paths.map((p) => [p, {}])) }));
  };
  const suggest = (registered: Array<{ id: string; root: string; status: string }> = []) =>
    suggestRepositories({ browseRoot: home, projectsDir: join(home, 'cezar', 'projects'), registered, home, claudeStateFile });

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-repos-')));
    claudeStateFile = join(home, '.claude.json');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lists registered projects first, then agent history newest first, then the scan', async () => {
    const registered = repo('work', 'registered');
    const older = repo('code', 'older');
    const newer = repo('code', 'newer');
    const scanned = repo('scratch', 'found');
    history(older, newer);

    const { repos } = await suggest([{ id: 'registered', root: registered, status: 'ok' }]);

    expect(repos.map((r) => r.path)).toEqual([registered, newer, older, scanned]);
    expect(repos[0]).toMatchObject({ name: 'registered', projectId: 'registered' });
  });

  it('never scans a privacy-protected home folder, but trusts one named by agent history', async () => {
    const remembered = repo('Documents', 'GitHub', 'remembered');
    repo('Documents', 'GitHub', 'unseen');
    history(remembered);

    const { repos } = await suggest();

    expect(repos.map((r) => r.path)).toEqual([remembered]);
  });

  it('skips non-repos, task worktrees and the home folder itself', async () => {
    mkdirSync(join(home, 'notes'), { recursive: true });
    const worktree = repo('code', 'app', '.ai', 'cezar', 'worktrees', 'abc');
    history(home, worktree, join(home, 'notes'));

    const { repos } = await suggest();

    expect(repos).toEqual([]);
  });

  it('degrades to the scan when the agent history is missing or unreadable', async () => {
    const scanned = repo('code', 'app');
    writeFileSync(claudeStateFile, '{not json');

    const { repos, truncated } = await suggest();

    expect(repos.map((r) => r.path)).toEqual([scanned]);
    expect(truncated).toBe(false);
  });

  it('ignores history entries outside the browse root', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cez-outside-')));
    mkdirSync(join(outside, '.git'));
    history(outside);
    try {
      expect((await suggest()).repos).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
