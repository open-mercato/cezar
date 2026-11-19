import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dryRunCommandRunner, type CommandRunner } from './create-project.ts';
import { DEFAULT_GITIGNORE, GIT_IDENTITY_MISSING, initGitInFolder } from './init-git.ts';

/** "Initialize git here" (spec 2026-10-26-first-run-onboarding). Real git; the dry-run runner
 *  lends the commit an identity so the host's git config does not matter. */
describe('initGitInFolder', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-init-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('commits the files already in the folder, so a task worktree is not empty', async () => {
    writeFileSync(join(root, 'notes.md'), '# notes\n');

    const result = await initGitInFolder({ root, run: dryRunCommandRunner });

    expect(result).toEqual({ ok: true, branch: 'main' });
    expect(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n')).toEqual(['.gitignore', 'notes.md']);
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe('main');
  });

  it('refuses a folder that already is a repository', async () => {
    mkdirSync(join(root, '.git'));

    expect(await initGitInFolder({ root, run: dryRunCommandRunner })).toMatchObject({ ok: false, status: 409 });
  });

  it('removes the .git it created when the commit fails, so a retry starts clean', async () => {
    const failingCommit: CommandRunner = (cmd, args, opts) =>
      args[0] === 'commit'
        ? Promise.resolve({ ok: false, error: 'Author identity unknown\n*** Please tell me who you are.' })
        : dryRunCommandRunner(cmd, args, opts);

    const result = await initGitInFolder({ root, run: failingCommit });

    expect(result).toEqual({ ok: false, status: 500, error: GIT_IDENTITY_MISSING });
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('never commits installed dependencies or .env secrets: a folder without a .gitignore gets one', async () => {
    writeFileSync(join(root, 'index.js'), 'console.log(1)\n');
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    writeFileSync(join(root, '.env.example'), 'SECRET=\n');
    mkdirSync(join(root, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules/left-pad/index.js'), '\n');

    expect(await initGitInFolder({ root, run: dryRunCommandRunner })).toEqual({ ok: true, branch: 'main' });
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
    expect(tracked.sort()).toEqual(['.env.example', '.gitignore', 'index.js']);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(DEFAULT_GITIGNORE);
  });

  it('keeps a .gitignore the folder already has', async () => {
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    await initGitInFolder({ root, run: dryRunCommandRunner });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('dist/\n');
  });

  it('refuses a home folder, a guarded folder in it, and a parent of home — nothing is created', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'Documents'), { recursive: true });
    for (const target of [home, join(home, 'Documents'), root]) {
      expect(await initGitInFolder({ root: target, home, run: dryRunCommandRunner })).toMatchObject({ ok: false, status: 409 });
    }
    expect(existsSync(join(home, '.git'))).toBe(false);
    mkdirSync(join(home, 'Documents/app'));
    expect(await initGitInFolder({ root: join(home, 'Documents/app'), home, run: dryRunCommandRunner })).toEqual({ ok: true, branch: 'main' });
  });

  it('keeps .env out even when the folder has its own .gitignore that forgets it', async () => {
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    writeFileSync(join(root, 'app.js'), '1\n');
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    writeFileSync(join(root, '.env.local'), 'SECRET=2\n');
    writeFileSync(join(root, '.env.example'), 'SECRET=\n');
    mkdirSync(join(root, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules/left-pad/index.js'), '\n');

    expect(await initGitInFolder({ root, run: dryRunCommandRunner })).toEqual({ ok: true, branch: 'main' });
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
    expect(tracked.sort()).toEqual(['.env.example', '.gitignore', 'app.js']);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('dist/\n');
    expect(readFileSync(join(root, '.git/info/exclude'), 'utf8')).toContain('.env.*');
  });

  it('sees through a symlink: a project registered as a link to home is still home', async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const link = join(root, 'looks-like-a-project');
    symlinkSync(home, link);
    expect(await initGitInFolder({ root: link, home, run: dryRunCommandRunner })).toMatchObject({ ok: false, status: 409 });
    expect(existsSync(join(home, '.git'))).toBe(false);
  });
});
