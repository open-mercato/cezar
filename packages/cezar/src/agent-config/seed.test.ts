import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgentConfigLocalLayer } from './seed.js';

let repo: string;
const env = process.env;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cez-seed-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), '.claude/settings.local.json\nCLAUDE.local.md\n');
  writeFileSync(join(repo, 'README.md'), '# x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** A linked worktree off HEAD, like a real run. */
function makeWorktree(): string {
  const wt = `${repo}-wt`;
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  return wt;
}

describe('seedAgentConfigLocalLayer', () => {
  it('copies a gitignored personal file into the worktree and excludes it', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"env":{"X":"1"}}');
    const wt = makeWorktree();
    try {
      const seeded = await seedAgentConfigLocalLayer(repo, wt, env);
      expect(seeded).toContain('.claude/settings.local.json');
      expect(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf8')).toBe('{"env":{"X":"1"}}');
      // info/exclude is on the common dir (shared) — the seeded file is ignored in the worktree
      expect(
        execFileSync('git', ['check-ignore', '.claude/settings.local.json'], { cwd: wt, encoding: 'utf8' }).trim(),
      ).toBe('.claude/settings.local.json');
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('no-ops when the source file is absent', async () => {
    const wt = makeWorktree();
    try {
      expect(await seedAgentConfigLocalLayer(repo, wt, env)).toEqual([]);
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('no-ops when the worktree cwd equals the repo root', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}');
    expect(await seedAgentConfigLocalLayer(repo, repo, env)).toEqual([]);
  });

  it('never seeds a file the user genuinely tracked (against advice)', async () => {
    // Track settings.local.json despite the .gitignore intent (force-add).
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"tracked":true}');
    git(repo, 'add', '-f', '.claude/settings.local.json');
    git(repo, 'commit', '-qm', 'track local');
    const wt = makeWorktree();
    try {
      const seeded = await seedAgentConfigLocalLayer(repo, wt, env);
      expect(seeded).toEqual([]); // check-ignore reports it as NOT ignored
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('is idempotent — a second run does not duplicate the exclude line', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}');
    const wt = makeWorktree();
    try {
      await seedAgentConfigLocalLayer(repo, wt, env);
      await seedAgentConfigLocalLayer(repo, wt, env);
      const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
      const hits = exclude.split('\n').filter((l) => l.trim() === '.claude/settings.local.json').length;
      expect(hits).toBe(1);
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });
});
