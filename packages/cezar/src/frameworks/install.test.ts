import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrameworkInstallSource } from './builtins.ts';
import { installFramework } from './install.ts';

/** `installFramework` against a local fixture of open-mercato/sdd's installer (a `file://` source). */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' }).trim();

/** Mirrors install.mjs @ 04ba2cc: copy skills/*, vendor .ai/sdd/, create the config if missing. */
const INSTALLER = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target || !fs.existsSync(path.join(target, '.git'))) { console.error('Usage: node install.mjs <path to a git repository>'); process.exit(1); }
fs.appendFileSync(path.join(target, '.install-runs'), 'ran\\n');
const dest = path.join(target, '.claude/skills');
fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(path.join(here, 'skills'))) {
  fs.rmSync(path.join(dest, name), { recursive: true, force: true });
  fs.cpSync(path.join(here, 'skills', name), path.join(dest, name), { recursive: true });
}
fs.mkdirSync(path.join(target, '.ai/sdd'), { recursive: true });
fs.writeFileSync(path.join(target, '.ai/sdd/sdd.mjs'), '// state script\\n');
const config = path.join(target, '.ai/agentic.config.json');
if (!fs.existsSync(config)) fs.writeFileSync(config, '{}\\n');
console.log('Skills installed');
`;

let tmp: string;
let sourceRepo: string;
let cacheRoot: string;
let repo: string;
let source: FrameworkInstallSource;

function makeSource(dir: string, installer = INSTALLER): string {
  mkdirSync(join(dir, 'skills/om-sdd'), { recursive: true });
  mkdirSync(join(dir, 'skills/om-sdd-spec'), { recursive: true });
  writeFileSync(join(dir, 'skills/om-sdd/SKILL.md'), '---\nname: om-sdd\n---\nbody\n');
  writeFileSync(join(dir, 'skills/om-sdd-spec/SKILL.md'), '---\nname: om-sdd-spec\n---\nbody\n');
  writeFileSync(join(dir, 'install.mjs'), installer);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'source');
  return git(dir, 'rev-parse', 'HEAD');
}

function sourceFor(dir: string, ref: string): FrameworkInstallSource {
  return {
    name: 'Open Mercato SDD',
    repo: pathToFileURL(dir).href,
    label: 'open-mercato/sdd',
    ref,
    installer: 'install.mjs',
    writes: ['.claude/skills/om-sdd*/', '.ai/sdd/', '.ai/agentic.config.json'],
    marker: '.ai/sdd/sdd.mjs',
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cez-fw-install-'));
  sourceRepo = join(tmp, 'sdd');
  mkdirSync(sourceRepo);
  source = sourceFor(sourceRepo, makeSource(sourceRepo));
  cacheRoot = join(tmp, 'cache');
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const runs = () => readFileSync(join(repo, '.install-runs'), 'utf8').split('\n').filter(Boolean).length;

describe('installFramework', () => {
  it('installs from the pinned commit into the cache and leaves the files uncommitted by default', async () => {
    const out = await installFramework(repo, 'open-mercato-sdd', source, { cacheRoot });
    expect(out).toMatchObject({ ok: true, committed: false, output: 'Skills installed' });
    if (!out.ok) return;
    expect(out.changedPaths).toEqual([
      '.ai/agentic.config.json',
      '.ai/sdd/sdd.mjs',
      '.claude/skills/om-sdd-spec/SKILL.md',
      '.claude/skills/om-sdd/SKILL.md',
    ]);
    expect(out.note).toMatch(/Cards run in worktrees off main/);
    expect(existsSync(join(cacheRoot, 'open-mercato-sdd', source.ref, 'install.mjs'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toContain('.ai/');
  });

  it('commits exactly the changed paths when on the base branch, leaving other staged work alone', async () => {
    writeFileSync(join(repo, 'mine.txt'), 'wip\n');
    git(repo, 'add', 'mine.txt');
    const out = await installFramework(repo, 'open-mercato-sdd', source, { cacheRoot, commit: true });
    expect(out).toMatchObject({ ok: true, committed: true });
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(`chore: install Open Mercato SDD (${source.ref.slice(0, 7)})`);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      '.ai/agentic.config.json',
      '.ai/sdd/sdd.mjs',
      '.claude/skills/om-sdd-spec/SKILL.md',
      '.claude/skills/om-sdd/SKILL.md',
    ]);
    expect(git(repo, 'status', '--porcelain')).toContain('A  mine.txt');
  });

  it('does not commit off the base branch, and says why', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    const out = await installFramework(repo, 'open-mercato-sdd', source, { cacheRoot, commit: true, baseBranch: 'main' });
    expect(out).toMatchObject({ ok: true, committed: false });
    if (out.ok) expect(out.note).toMatch(/you are on feature, not main/);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('init');
  });

  it('reuses the cached checkout: a second install works with the source gone', async () => {
    expect((await installFramework(repo, 'open-mercato-sdd', source, { cacheRoot, commit: true })).ok).toBe(true);
    rmSync(sourceRepo, { recursive: true, force: true });
    const again = await installFramework(repo, 'open-mercato-sdd', source, { cacheRoot, commit: true });
    expect(again).toMatchObject({ ok: true, changedPaths: [], committed: false, note: expect.stringMatching(/already installed/) });
    expect(runs()).toBe(2);
  });

  it('refuses to reinstall over local changes to an existing install', async () => {
    await installFramework(repo, 'open-mercato-sdd', source, { cacheRoot, commit: true });
    writeFileSync(join(repo, '.claude/skills/om-sdd/SKILL.md'), 'my edit\n');
    const out = await installFramework(repo, 'open-mercato-sdd', source, { cacheRoot });
    expect(out).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/^commit or discard local changes first/) });
    expect(readFileSync(join(repo, '.claude/skills/om-sdd/SKILL.md'), 'utf8')).toBe('my edit\n');
    expect(runs()).toBe(1);
  });

  it('runs once for two concurrent clicks on the same repo', async () => {
    const [a, b] = await Promise.all([
      installFramework(repo, 'open-mercato-sdd', source, { cacheRoot }),
      installFramework(repo, 'open-mercato-sdd', source, { cacheRoot }),
    ]);
    expect(a).toBe(b);
    expect(runs()).toBe(1);
  });

  it('maps a failed download to one line, never a throw', async () => {
    const out = await installFramework(repo, 'open-mercato-sdd', sourceFor(join(tmp, 'nowhere'), source.ref), { cacheRoot });
    expect(out).toMatchObject({ ok: false, code: 'failed', error: expect.stringMatching(/^could not download open-mercato\/sdd at [0-9a-f]{7}: /) });
    if (!out.ok) expect(out.error).not.toContain('\n');
    expect(existsSync(join(repo, '.ai/sdd'))).toBe(false);
  });

  it('refuses a ref that is not a full sha, and a checkout of another commit', async () => {
    const short = await installFramework(repo, 'open-mercato-sdd', { ...source, ref: source.ref.slice(0, 7) }, { cacheRoot });
    expect(short).toMatchObject({ ok: false, code: 'failed', error: expect.stringMatching(/not a full commit sha/) });
    const other = await installFramework(repo, 'open-mercato-sdd', { ...source, ref: 'f'.repeat(40) }, { cacheRoot });
    expect(other).toMatchObject({ ok: false, code: 'failed' });
  });

  it('maps an installer failure to its message', async () => {
    const broken = join(tmp, 'broken');
    mkdirSync(broken);
    const ref = makeSource(broken, "console.error('boom: no skills here'); process.exit(1);\n");
    const out = await installFramework(repo, 'open-mercato-sdd', sourceFor(broken, ref), { cacheRoot });
    expect(out).toEqual({ ok: false, code: 'failed', error: 'the open-mercato/sdd installer failed: boom: no skills here' });
  });

  it('refuses a folder that is not a git repository', async () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    const out = await installFramework(plain, 'open-mercato-sdd', source, { cacheRoot });
    expect(out).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/not a git repository/) });
  });
});
