import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A throwaway git repo for the impact evidence and CLI tests. */
export interface FixtureRepo {
  root: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commit: (message: string) => string;
  dispose: () => void;
}

export function fixtureRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), 'cez-impact-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  return {
    root,
    git,
    write: (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    commit: (message) => {
      git('add', '--all');
      git('commit', '-qm', message);
      return git('rev-parse', 'HEAD').trim();
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
