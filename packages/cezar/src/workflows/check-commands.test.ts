import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENTIC_CONFIG_PATH,
  CHECK_PLAN_DIGEST_VERSION,
  MAKEFILE_PATH,
  PACKAGE_JSON_PATH,
  PACKAGE_LOCK_PATH,
  commandInvokesMake,
  normalizeCommands,
  npmScriptName,
  resolveCheckCommands,
  type CheckCommandResolution,
} from './check-commands.ts';

/**
 * The command policy (landing-check PR 3). Every case works on a REAL scratch git
 * repo: the frozen base is a commit, the candidate is the working tree, and the
 * resolver is expected to read both — never to run anything out of either.
 *
 * The one rule that must survive every future change here is asserted twice: the
 * module's only subprocesses are fixed-argv `git` reads (the mock on
 * `node:child_process`), and a command string that would leave a trace does not
 * leave one (the poisoned fixture).
 */

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@cezar.local');
  git(dir, 'config', 'user.name', 'cezar-test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

/** Write the files, commit them, and return the frozen base sha. */
function freeze(dir: string, files: Record<string, string>, message = 'base'): string {
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** The candidate is the WORKING TREE: a write without a commit is the change under test. */
function candidate(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function pkg(scripts: Record<string, string>): string {
  return `${JSON.stringify({ name: 'fixture', private: true, scripts }, null, 2)}\n`;
}

/** The workspace shape: a root manifest with `workspaces` globs, and a named workspace manifest. */
function workspaceRoot(scripts: Record<string, string>, workspaces: string[] = ['packages/*']): string {
  return `${JSON.stringify({ name: 'fixture', private: true, workspaces, scripts }, null, 2)}\n`;
}

function pkgNamed(name: string, scripts: Record<string, string>): string {
  return `${JSON.stringify({ name, private: true, scripts }, null, 2)}\n`;
}

function config(commands: string[]): string {
  return `${JSON.stringify({ version: 1, validation: { commands } }, null, 2)}\n`;
}

function resolve(dir: string, baseSha: string, explicit?: string[]): CheckCommandResolution {
  return resolveCheckCommands({ baseSha, repoRoot: dir, ...(explicit ? { explicit } : {}) });
}

const notes = (resolution: CheckCommandResolution): string => resolution.notes.join('\n');
const commands = (resolution: CheckCommandResolution): string[] => resolution.commands.map((c) => c.command);

describe('check-commands — the command policy resolver', () => {
  let dir: string;
  let baseSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-check-commands-'));
    initRepo(dir);
    baseSha = '';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('precedence — explicit → .ai/agentic.config.json → package.json', () => {
    it('an explicit list wins over both repo sources and still resolves its bodies from the base', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm run build']),
        'package.json': pkg({ build: 'tsc -b', test: 'vitest run' }),
      });

      const resolution = resolve(dir, baseSha, ['npm run test']);

      expect(resolution.status).toBe('resolved');
      expect(resolution.source).toBe('explicit');
      expect(commands(resolution)).toEqual(['npm run test']);
      expect(resolution.commands[0]?.script).toEqual({ name: 'test', body: 'vitest run' });
      expect(notes(resolution)).toContain(`${AGENTIC_CONFIG_PATH} (base ${baseSha.slice(0, 8)}): not consulted (an explicit list wins)`);
    });

    it('.ai/agentic.config.json wins over package.json discovery', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm run typecheck', 'npm test']),
        'package.json': pkg({ build: 'tsc -b', test: 'vitest run' }),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(resolution.source).toBe('agentic-config');
      expect(commands(resolution)).toEqual(['npm run typecheck', 'npm test']);
      expect(notes(resolution)).toContain(`package.json (base ${baseSha.slice(0, 8)}): consulted for script bodies only (a higher-precedence source won the list)`);
    });

    it('package.json discovery runs when the config is absent — cheap-first, no silent reorder', () => {
      baseSha = freeze(dir, { 'package.json': pkg({ test: 'vitest run', build: 'tsc -b', lint: 'eslint .' }) });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(resolution.source).toBe('package-json');
      expect(commands(resolution)).toEqual(['npm run lint', 'npm test', 'npm run build']);
      expect(notes(resolution)).toContain(`${AGENTIC_CONFIG_PATH} (base ${baseSha.slice(0, 8)}): absent`);
    });

    it('keeps the declared order — the engine never reorders a source', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test', 'npm run lint']),
        'package.json': pkg({ test: 'vitest run', lint: 'eslint .' }),
      });

      expect(commands(resolve(dir, baseSha))).toEqual(['npm test', 'npm run lint']);
    });

    it('a candidate that moves the list to an equal source is not drift (same commands, same bodies)', () => {
      baseSha = freeze(dir, { 'package.json': pkg({ lint: 'eslint .', test: 'vitest run' }) });
      candidate(dir, { '.ai/agentic.config.json': config(['npm run lint', 'npm test']) });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(resolution.source).toBe('package-json');
      expect(commands(resolution)).toEqual(['npm run lint', 'npm test']);
      expect(resolution.changedVsBase).toBe(false);
    });
  });

  describe('nothing to check — an absent or empty source, naming every source consulted', () => {
    it('degrades to no-commands when nothing declares a command', () => {
      baseSha = freeze(dir, { 'package.json': pkg({ dev: 'vite' }) });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('no-commands');
      expect(commands(resolution)).toEqual([]);
      expect(resolution.changedVsBase).toBe(false);
      expect(resolution.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const text = notes(resolution);
      for (const source of ['explicit:', AGENTIC_CONFIG_PATH, PACKAGE_JSON_PATH, MAKEFILE_PATH]) {
        expect(text).toContain(source);
      }
      expect(text).toContain('no-commands: no source declares a command — nothing to run');
    });

    it('treats an empty validation.commands array as empty, not as malformed', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config([]),
        'package.json': pkg({ dev: 'vite' }),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('no-commands');
      expect(notes(resolution)).toContain(`${AGENTIC_CONFIG_PATH} (base ${baseSha.slice(0, 8)}): present, no validation.commands — falls through`);
    });

    it('a no-commands resolution announces the install step it would have needed', () => {
      baseSha = freeze(dir, { 'package.json': pkg({ dev: 'vite' }), [PACKAGE_LOCK_PATH]: '{}\n' });

      const resolution = resolve(dir, baseSha);

      expect(resolution.install).toMatchObject({ kind: 'ci', argv: ['npm', 'ci'] });
      expect(resolution.install.because).toContain(PACKAGE_LOCK_PATH);
    });
  });

  describe('base-pinning and the drift rule', () => {
    it('refuses to run when the candidate moves the list, and shows the diff', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm run typecheck', 'npm test']),
        'package.json': pkg({ typecheck: 'tsc --noEmit', test: 'vitest run' }),
      });
      candidate(dir, { '.ai/agentic.config.json': config(['npm test']) });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.changedVsBase).toBe(true);
      expect(commands(resolution)).toEqual([]);
      expect(resolution.diff).toContain('@@ commands @@');
      expect(resolution.diff).toContain('- npm run typecheck');
      expect(resolution.diff).toContain('+ npm test');
      expect(notes(resolution)).toContain('commands-changed-vs-base: the candidate moved the pinned plan — nothing was run');
    });

    it('refuses to run when only a script BODY moved — the list alone is not the gate', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });
      candidate(dir, { 'package.json': pkg({ test: 'vitest run --exclude realsuite' }) });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:test @@');
      expect(resolution.diff).toContain('- vitest run');
      expect(resolution.diff).toContain('+ vitest run --exclude realsuite');
    });

    it('pins the npm lifecycle hooks (pre*/post*) of a referenced script', () => {
      const withHook = (hook: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'node t.js', pretest: hook }),
      });
      baseSha = freeze(dir, withHook('node pre.js'));
      candidate(dir, withHook('node pre-moved.js'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:pretest @@');
      expect(resolution.diff).toContain('+ node pre-moved.js');
    });

    it('pins the install lifecycle hooks that the install step executes', () => {
      const withHook = (hook: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'node t.js', postinstall: hook }),
        [PACKAGE_LOCK_PATH]: '{}\n',
      });
      baseSha = freeze(dir, withHook('node install.js'));
      candidate(dir, withHook('node install-moved.js'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:postinstall @@');
    });

    it('refuses when the candidate deletes a script the frozen list names', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });
      candidate(dir, { 'package.json': pkg({}) });

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:test @@');
      expect(resolution.diff).toContain('(no such script in the candidate)');
    });

    it('refuses when the candidate introduces a config the base did not have', () => {
      baseSha = freeze(dir, { 'package.json': pkg({ dev: 'vite' }) });
      candidate(dir, { '.ai/agentic.config.json': config(['npm test']) });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('+ npm test');
    });

    it('does not flag an install-kind difference as command drift — the frozen base still decides the argv', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });
      candidate(dir, { [PACKAGE_LOCK_PATH]: '{}\n' });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(resolution.install.kind).toBe('install');
      expect(resolution.changedVsBase).toBe(false);
    });
  });

  describe('the digest — the list AND the resolved bodies', () => {
    it('changes when a body changes but the list does not', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });
      const first = resolve(dir, baseSha);
      baseSha = freeze(dir, { 'package.json': pkg({ test: 'vitest run --silent' }) }, 'body moved');
      const second = resolve(dir, baseSha);

      expect(commands(first)).toEqual(commands(second));
      expect(first.digest).not.toBe(second.digest);
    });

    it('changes when the list order changes', () => {
      const both = (order: string[]): Record<string, string> => ({
        '.ai/agentic.config.json': config(order),
        'package.json': pkg({ lint: 'eslint .', test: 'vitest run' }),
      });
      baseSha = freeze(dir, both(['npm run lint', 'npm test']));
      const first = resolve(dir, baseSha);
      baseSha = freeze(dir, both(['npm test', 'npm run lint']), 'reordered');
      const second = resolve(dir, baseSha);

      expect(first.digest).not.toBe(second.digest);
    });

    it('is stable across identical resolutions — the same plan is the same digest', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });

      expect(resolve(dir, baseSha).digest).toBe(resolve(dir, baseSha).digest);
    });

    it('changes when a WORKSPACE script body changes — the delegation is in the payload', () => {
      const files = (workspace: Record<string, string>): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run test:unit']),
        'package.json': workspaceRoot({ 'test:unit': 'npm run test:unit -w @acme/pkg' }),
        'packages/pkg/package.json': pkgNamed('@acme/pkg', workspace),
      });
      baseSha = freeze(dir, files({ 'test:unit': 'vitest run' }));
      const first = resolve(dir, baseSha);
      baseSha = freeze(dir, files({ 'test:unit': 'vitest run --silent' }), 'workspace body moved');
      const second = resolve(dir, baseSha);

      expect(first.digest).not.toBe(second.digest);
      // The payload version is the contract for every consumer that compares digests.
      expect(CHECK_PLAN_DIGEST_VERSION).toBe(4);
    });

    it('changes when the base\'s root "workspaces" globs change — the topology is in the payload (v4)', () => {
      const files = (workspaces: string[]): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run test:unit']),
        'package.json': workspaceRoot({ 'test:unit': 'npm run test:unit -w @acme/pkg' }, workspaces),
        'packages/pkg/package.json': pkgNamed('@acme/pkg', { 'test:unit': 'vitest run' }),
      });
      baseSha = freeze(dir, files(['packages/*']));
      const first = resolve(dir, baseSha);
      // `vendor/*` matches no manifest, so every pinned body is identical — only the
      // topology moved, and it must move the digest too.
      baseSha = freeze(dir, files(['packages/*', 'vendor/*']), 'topology moved');
      const second = resolve(dir, baseSha);

      expect(first.digest).not.toBe(second.digest);
    });
  });

  describe('the Makefile — surfaced, never run', () => {
    it('lists the base Makefile targets in the notes and never promotes them to a command', () => {
      baseSha = freeze(dir, {
        'package.json': pkg({ dev: 'vite' }),
        [MAKEFILE_PATH]: 'deploy:\n\techo deploy\n\ntest:\n\tnode --test\n',
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(commands(resolution)).toEqual([]);
      expect(resolution.makefile).toEqual({ present: true, targets: ['deploy', 'test'] });
      expect(notes(resolution)).toContain('Makefile (base');
      expect(notes(resolution)).toContain('make deploy');
      expect(notes(resolution)).toContain('never run');
    });

    it('pins the Makefile text when the list invokes make — a moved target body is drift', () => {
      const withMake = (body: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['make test']),
        'package.json': pkg({}),
        [MAKEFILE_PATH]: `test:\n\t${body}\n`,
      });
      baseSha = freeze(dir, withMake('node --test'));
      candidate(dir, withMake('node --test --exclude slow'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain(`@@ ${MAKEFILE_PATH} @@`);
      expect(resolution.diff).toContain('+ \tnode --test --exclude slow');
    });

    it('does not pin a Makefile the list never invokes', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
        [MAKEFILE_PATH]: 'test:\n\tnode --test\n',
      });
      candidate(dir, { [MAKEFILE_PATH]: 'test:\n\tnode --test --moved\n' });

      expect(resolve(dir, baseSha).status).toBe('resolved');
    });

    it('a make command with no Makefile in the base is surfaced as an unpinned body', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['make test']),
        'package.json': pkg({}),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(commands(resolution)).toEqual(['make test']);
      expect(notes(resolution)).toContain(`${MAKEFILE_PATH} (base ${baseSha.slice(0, 8)}): absent`);
    });
  });

  describe('the install argv — from the frozen base manifest', () => {
    it('npm ci when the base carries a lockfile', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
        [PACKAGE_LOCK_PATH]: '{}\n',
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.install).toEqual({ kind: 'ci', argv: ['npm', 'ci'], because: `${PACKAGE_LOCK_PATH} present in base ${baseSha.slice(0, 8)}` });
      expect(notes(resolution)).toContain(`install (base ${baseSha.slice(0, 8)}): npm ci — ${PACKAGE_LOCK_PATH} present`);
    });

    it('npm install when the base carries only a manifest', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });

      expect(resolve(dir, baseSha).install).toEqual({ kind: 'install', argv: ['npm', 'install'], because: `${PACKAGE_JSON_PATH} present in base ${baseSha.slice(0, 8)}` });
    });

    it('nothing when the base carries neither', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['./scripts/gate.sh']),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(resolution.install.kind).toBe('none');
      expect(resolution.install.argv).toEqual([]);
      expect(commands(resolution)).toEqual(['./scripts/gate.sh']);
    });
  });

  describe('malformed sources — could-not-run, never a silent fallback', () => {
    it('a malformed base config refuses the whole check instead of falling through to package.json', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': '{ not json\n',
        'package.json': pkg({ test: 'vitest run' }),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('could-not-run');
      expect(resolution.reason).toBe('malformed-agentic-config');
      expect(commands(resolution)).toEqual([]);
      expect(notes(resolution)).toContain('nothing may run');
    });

    it('validation.commands that is not an array of strings is malformed', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': `${JSON.stringify({ validation: { commands: 'npm test' } })}\n`,
        'package.json': pkg({ test: 'vitest run' }),
      });

      expect(resolve(dir, baseSha).reason).toBe('malformed-agentic-config');
    });

    it('a malformed base manifest refuses the check', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': '{ oops\n',
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('could-not-run');
      expect(resolution.reason).toBe('malformed-package-json');
      expect(commands(resolution)).toEqual([]);
    });

    it('a malformed CANDIDATE config is drift — the candidate cannot be pinned', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });
      candidate(dir, { '.ai/agentic.config.json': '{ not json\n' });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ source @@');
      expect(resolution.diff).toContain('unreadable');
      expect(commands(resolution)).toEqual([]);
    });

    it('an explicit list wins before the config is ever consulted — its state cannot block the check', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': '{ not json\n',
        'package.json': pkg({ test: 'vitest run' }),
      });

      const resolution = resolve(dir, baseSha, ['npm test']);

      expect(resolution.status).toBe('resolved');
      expect(resolution.source).toBe('explicit');
    });

    it('an unresolvable base is could-not-run, not a crash', () => {
      const plain = mkdtempSync(join(tmpdir(), 'cez-not-a-repo-'));
      try {
        const resolution = resolveCheckCommands({ baseSha: 'deadbeef', repoRoot: plain });
        expect(resolution.status).toBe('could-not-run');
        expect(resolution.reason).toBe('unreadable-base');
        expect(commands(resolution)).toEqual([]);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });
  });

  describe('it executes nothing', () => {
    it('spawns only fixed-argv git reads — no shell, no command from either tree', () => {
      const poison = `touch ${join(dir, 'POISON')}`;
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config([poison, 'npm test']),
        'package.json': workspaceRoot({ test: 'npm run probe', probe: 'npm run probe -w @fixture/poison' }),
        'packages/poison/package.json': pkgNamed('@fixture/poison', { probe: poison }),
        [MAKEFILE_PATH]: `${poison}-target:\n\t${poison}\n`,
      });
      candidate(dir, { '.ai/agentic.config.json': config([poison, 'npm test', 'false']) });
      const mocked = vi.mocked(execFileSync);
      mocked.mockClear();

      resolve(dir, baseSha);

      const calls = mocked.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // The `-w` probe is what makes `ls-tree` run and the candidate's own glob set
      // is what makes `ls-files` run — both read-only, both fixed argv.
      const verbs = calls.map(([, args]) => (Array.isArray(args) ? args[0] : undefined));
      expect(verbs).toContain('ls-tree');
      expect(verbs).toContain('ls-files');
      for (const [program, args] of calls) {
        expect(program).toBe('git');
        expect(['rev-parse', 'show', 'ls-tree', 'ls-files']).toContain(Array.isArray(args) ? args[0] : undefined);
        expect(JSON.stringify(args)).not.toContain('POISON');
      }
      expect(existsSync(join(dir, 'POISON'))).toBe(false);
    });

    it('a resolution never carries a command unless it is `resolved`', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
      });
      candidate(dir, { '.ai/agentic.config.json': config(['npm test', 'false']) });

      const resolution = resolve(dir, baseSha);
      expect(resolution.status).not.toBe('resolved');
      expect(resolution.commands).toEqual([]);
    });
  });

  describe('unit helpers', () => {
    it('normalizes whitespace outside quotes, drops blanks, dedupes, keeps order', () => {
      expect(normalizeCommands(['  npm   test ', 'npm test', '', '  ', 'npm run x -- --grep "a  b"']))
        .toEqual(['npm test', 'npm run x -- --grep "a  b"']);
    });

    it('reads the npm script a command addresses — and only that', () => {
      expect(npmScriptName('npm test')).toBe('test');
      expect(npmScriptName('npm test -- --watch')).toBe('test');
      expect(npmScriptName('npm run build -w @open-mercato/cezar')).toBe('build');
      expect(npmScriptName('npm run-script check:pack')).toBe('check:pack');
      expect(npmScriptName('npm ci')).toBeUndefined();
      expect(npmScriptName('npm install')).toBeUndefined();
      expect(npmScriptName('./scripts/gate.sh')).toBeUndefined();
      expect(npmScriptName('make test')).toBeUndefined();
    });

    it('recognizes a make invocation', () => {
      expect(commandInvokesMake('make test')).toBe(true);
      expect(commandInvokesMake('make')).toBe(true);
      expect(commandInvokesMake('npm run make-stuff')).toBe(false);
    });
  });

  describe('the npm-run closure — a stub is not a body (F1)', () => {
    it('refuses when the candidate neuters a script an inner npm run delegates to — the reviewer’s probe', () => {
      const manifest = (inner: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'npm run inner', inner }),
      });
      baseSha = freeze(dir, manifest('vitest run'));
      candidate(dir, manifest('echo "all good"'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.changedVsBase).toBe(true);
      expect(commands(resolution)).toEqual([]);
      expect(resolution.diff).toContain('@@ script:inner @@');
      expect(resolution.diff).toContain('- vitest run');
      expect(resolution.diff).toContain('+ echo "all good"');
    });

    it('refuses when the candidate neuters the tail of a compound command', () => {
      const manifest = (typecheck: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run lint && npm run typecheck']),
        'package.json': pkg({ lint: 'eslint .', typecheck }),
      });
      baseSha = freeze(dir, manifest('tsc --noEmit'));
      candidate(dir, manifest('exit 0'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:typecheck @@');
      expect(resolution.diff).toContain('+ exit 0');
    });

    it('pins a sub-script two npm runs deep, and the pre*/post* hooks of the whole chain', () => {
      const manifest = (hook: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'npm run inner', inner: 'npm run deep', deep: 'node deep.js', predeep: hook }),
      });
      baseSha = freeze(dir, manifest('node pre-deep.js'));
      candidate(dir, manifest('node pre-deep-moved.js'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:predeep @@');
      expect(resolution.diff).toContain('+ node pre-deep-moved.js');
    });

    it('pins a local script file the argv names — a moved file is drift', () => {
      const manifest = (body: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['./scripts/gate.sh']),
        'package.json': pkg({}),
        'scripts/gate.sh': `#!/bin/sh\n${body}\n`,
      });
      baseSha = freeze(dir, manifest('npm run typecheck'));
      candidate(dir, manifest('exit 0'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ file:scripts/gate.sh @@');
      expect(resolution.diff).toContain('+ exit 0');
    });

    it('pins a local script file named in argv as an interpreter argument', () => {
      const manifest = (body: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['sh ./scripts/gate.sh']),
        'package.json': pkg({}),
        'scripts/gate.sh': `#!/bin/sh\n${body}\n`,
      });
      baseSha = freeze(dir, manifest('npm run build'));
      candidate(dir, manifest('true'));

      expect(resolve(dir, baseSha).reason).toBe('commands-changed-vs-base');
    });

    it('terminates on an npm-run cycle and still pins every body in it', () => {
      const manifest = (b: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run a']),
        'package.json': pkg({ a: 'npm run b', b }),
      });
      baseSha = freeze(dir, manifest('npm run a'));
      candidate(dir, manifest('echo ok'));

      expect(resolve(dir, baseSha).status).toBe('nothing-to-check');
      expect(resolve(dir, baseSha).reason).toBe('commands-changed-vs-base');
      expect(resolve(dir, baseSha).diff).toContain('@@ script:b @@');
    });

    it('records a dynamic npm-run reference as not pinned instead of guessing a name', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'npm run "$TARGET"' }),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('$TARGET');
      expect(notes(resolution)).toContain('not pinned');
    });

    it('bounds the npm-run chain and records what the bound left unpinned', () => {
      const scripts: Record<string, string> = {};
      for (let hop = 0; hop < 20; hop += 1) scripts[`s${hop}`] = `npm run s${hop + 1}`;
      scripts['s20'] = 'node end.js';
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm run s0']),
        'package.json': pkg(scripts),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('npm-run chain');
      expect(notes(resolution)).toContain('not pinned');
    });

    it('records a workspace delegation as a manifest this resolver does not pin', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm run build:server']),
        'package.json': pkg({ 'build:server': 'npm run build -w @open-mercato/cezar' }),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('@open-mercato/cezar');
      expect(notes(resolution)).toContain('workspace');
      expect(notes(resolution)).toContain('not pinned');
    });
  });

  describe('the workspace manifests behind -w delegations (PR 3.2)', () => {
    /** This repo's own gate shape: a thin root stub delegating the body with `-w`. */
    const delegated = (root: Record<string, string>, workspace: Record<string, string>): Record<string, string> => ({
      '.ai/agentic.config.json': config(['npm run test:unit']),
      'package.json': workspaceRoot(root),
      'packages/pkg/package.json': pkgNamed('@acme/pkg', workspace),
    });
    const delegating = { 'test:unit': 'npm run test:unit -w @acme/pkg' };

    it('refuses when the candidate neuters a script behind a -w delegation — the root body unchanged', () => {
      const files = (workspace: Record<string, string>): Record<string, string> => delegated(delegating, workspace);
      baseSha = freeze(dir, files({ 'test:unit': 'node --import tsx --test test/unit/*.test.ts' }));
      candidate(dir, files({ 'test:unit': 'exit 0' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.changedVsBase).toBe(true);
      expect(commands(resolution)).toEqual([]);
      expect(resolution.diff).toContain('@@ workspace:packages/pkg/package.json#test:unit @@');
      expect(resolution.diff).toContain('- node --import tsx --test test/unit/*.test.ts');
      expect(resolution.diff).toContain('+ exit 0');
      expect(notes(resolution)).toContain('→ packages/pkg/package.json');
    });

    it('covers a workspace script recursively, and its pre*/post* hooks', () => {
      const files = (inner: string, hook: string): Record<string, string> =>
        delegated(delegating, { 'test:unit': 'npm run inner', inner, 'pretest:unit': hook });
      baseSha = freeze(dir, files('tsc -b', 'node pre.js'));
      candidate(dir, files('exit 0', 'node pre.js'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ workspace:packages/pkg/package.json#inner @@');
      expect(resolution.diff).toContain('+ exit 0');

      candidate(dir, files('tsc -b', 'node pre-moved.js'));
      const hookDrifted = resolve(dir, baseSha);
      expect(hookDrifted.reason).toBe('commands-changed-vs-base');
      expect(hookDrifted.diff).toContain('@@ workspace:packages/pkg/package.json#pretest:unit @@');
      expect(hookDrifted.diff).toContain('+ node pre-moved.js');
    });

    it('resolves the workspace by path, by --workspace=<name>, and by -ws/--workspaces', () => {
      const root = (delegation: string): Record<string, string> => delegated({ 'test:unit': `npm run test:unit ${delegation}` }, { 'test:unit': 'vitest run' });
      for (const delegation of ['-w packages/pkg', '--workspace=@acme/pkg', '-ws']) {
        baseSha = freeze(dir, root(delegation), `delegation ${delegation}`);

        const resolution = resolve(dir, baseSha);

        expect(resolution.status, delegation).toBe('resolved');
        expect(notes(resolution), delegation).toContain('→ packages/pkg/package.json');
      }
    });

    it('pins --workspaces in every manifest that defines the script', () => {
      const files = (first: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm test --workspaces' }),
        'packages/a/package.json': pkgNamed('@acme/a', { test: first }),
        'packages/b/package.json': pkgNamed('@acme/b', { test: 'vitest run' }),
      });
      baseSha = freeze(dir, files('vitest run --pool forks'));
      candidate(dir, files('exit 0'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#test @@');
      expect(resolution.diff).toContain('+ exit 0');
      expect(resolution.diff).not.toContain('packages/b/package.json#test');
      expect(notes(resolution)).toContain('npm --workspaces → packages/a/package.json, packages/b/package.json');
    });

    it('refuses when the candidate deletes the manifest the delegation resolves to', () => {
      const files: Record<string, string> = delegated(delegating, { 'test:unit': 'vitest run' });
      baseSha = freeze(dir, files);
      rmSync(join(dir, 'packages/pkg/package.json'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ workspace:packages/pkg/package.json#test:unit @@');
      expect(resolution.diff).toContain('(no such script in the candidate)');
    });

    it('is honest when the name matches no manifest: a note, nothing pinned, no false drift', () => {
      const files = (workspace: Record<string, string>): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run test:unit']),
        'package.json': workspaceRoot({ 'test:unit': 'npm run test:unit -w @acme/other' }),
        'packages/pkg/package.json': pkgNamed('@acme/pkg', workspace),
      });
      baseSha = freeze(dir, files({ 'test:unit': 'vitest run' }));
      candidate(dir, files({ 'test:unit': 'exit 0' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('no workspace manifest named or at "@acme/other"');
      expect(notes(resolution)).toContain('not pinned');
    });

    it('never reads a workspace manifest when no -w delegation appears — guard', () => {
      const files = (workspace: Record<string, string>): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run test:unit']),
        'package.json': workspaceRoot({ 'test:unit': 'vitest run' }),
        'packages/pkg/package.json': pkgNamed('@acme/pkg', workspace),
      });
      baseSha = freeze(dir, files({ test: 'vitest run' }));
      candidate(dir, files({ test: 'exit 0' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).not.toContain('packages/pkg/package.json');
    });
  });

  describe('the workspace topology and the npm flag scan (PR 3.3)', () => {
    /** The redirect probe: one delegation name, resolvable to two different manifests. */
    const redirected = (workspaces: string[], builds: { a?: string; vendor?: string }): Record<string, string> => ({
      '.ai/agentic.config.json': config(['npm run build']),
      'package.json': workspaceRoot({ build: 'npm run build -w @scope/a' }, workspaces),
      ...(builds.a === undefined ? {} : { 'packages/a/package.json': pkgNamed('@scope/a', { build: builds.a }) }),
      ...(builds.vendor === undefined ? {} : { 'vendor/a/package.json': pkgNamed('@scope/a', { build: builds.vendor }) }),
    });

    it('refuses when the candidate moves the root "workspaces" globs — the redirect is drift, not a valid pin', () => {
      baseSha = freeze(dir, redirected(['packages/*'], { a: 'echo REAL' }));
      // Every pinned body stays byte-identical; only the topology moves, so npm now
      // resolves `-w @scope/a` to vendor/a — a manifest the frozen base never pinned.
      candidate(dir, redirected(['vendor/*'], { vendor: 'exit 0' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.changedVsBase).toBe(true);
      expect(commands(resolution)).toEqual([]);
      expect(resolution.diff).toContain('@@ workspaces @@');
      expect(resolution.diff).toContain('- "packages/*"');
      expect(resolution.diff).toContain('+ "vendor/*"');
      // The base's delegation note must not read as a pin under a topology the candidate moved.
      expect(notes(resolution)).not.toContain('script is pinned');
      expect(notes(resolution)).toContain('is NOT pinned at run time');
      expect(notes(resolution)).toContain('root package.json "workspaces" changed: ["packages/*"] → ["vendor/*"]');
    });

    it('treats a respelled glob as the same topology — guard', () => {
      baseSha = freeze(dir, redirected(['packages/*'], { a: 'echo REAL' }));
      const first = resolve(dir, baseSha);
      // `./packages/*` resolves to the same manifests; normalization must not refuse it.
      candidate(dir, redirected(['./packages/*'], { a: 'echo REAL' }));

      const respelled = resolve(dir, baseSha);

      expect(respelled.status).toBe('resolved');
      expect(respelled.diff).toBe('');

      // A repeated glob names the same set, and a respelled BASE is the same plan.
      candidate(dir, redirected(['packages/*', 'packages/*'], { a: 'echo REAL' }));
      expect(resolve(dir, baseSha).status).toBe('resolved');
      baseSha = freeze(dir, redirected(['./packages/*'], { a: 'echo REAL' }), 'respelled base');
      expect(resolve(dir, baseSha).digest).toBe(first.digest);
    });

    it('refuses a topology move even when no delegation is pinned — conservative by design', () => {
      const root = (workspaces?: string[]): Record<string, string> => {
        const manifest = { name: 'fixture', private: true, ...(workspaces ? { workspaces } : {}), scripts: { test: 'vitest run' } };
        return { '.ai/agentic.config.json': config(['npm test']), 'package.json': `${JSON.stringify(manifest, null, 2)}\n` };
      };
      baseSha = freeze(dir, root(['packages/*']));

      candidate(dir, root(['vendor/*', 'packages/*']));
      const added = resolve(dir, baseSha);
      expect(added.reason).toBe('commands-changed-vs-base');
      expect(added.diff).toContain('@@ workspaces @@');
      expect(added.diff).toContain('+ "vendor/*"');

      candidate(dir, root());
      const removed = resolve(dir, baseSha);
      expect(removed.reason).toBe('commands-changed-vs-base');
      expect(removed.diff).toContain('- "packages/*"');
      expect(notes(removed)).toContain('root package.json "workspaces" changed: ["packages/*"] → []');
    });

    it('pins the inner script behind a leading global npm flag — the stub no longer hides it', () => {
      for (const flag of ['--silent', '-s', '--loglevel=error']) {
        const files = (inner: string): Record<string, string> => ({
          '.ai/agentic.config.json': config(['npm test']),
          'package.json': pkg({ test: `npm ${flag} run inner`, inner }),
        });
        baseSha = freeze(dir, files('echo REAL'), `base ${flag}`);
        candidate(dir, files('exit 0'));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status, flag).toBe('nothing-to-check');
        expect(resolution.reason, flag).toBe('commands-changed-vs-base');
        expect(resolution.diff, flag).toContain('@@ script:inner @@');
      }
    });

    it('pins the script behind a leading global flag on the test verb too', () => {
      const files = (inner: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run probe']),
        'package.json': pkg({ probe: 'npm --silent test', test: inner }),
      });
      baseSha = freeze(dir, files('echo REAL'));
      candidate(dir, files('exit 0'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:test @@');
    });

    it('skips the separate value of a value-taking global flag before the verb', () => {
      const valueFlags = [
        '--loglevel error',
        '--prefix .',
        '--registry http://127.0.0.1:1',
        '--userconfig .npmrc',
        '--cache /tmp/cez-npm-cache',
      ];
      for (const flag of valueFlags) {
        const files = (inner: string): Record<string, string> => ({
          '.ai/agentic.config.json': config(['npm test']),
          'package.json': pkg({ test: `npm ${flag} run inner`, inner }),
        });
        baseSha = freeze(dir, files('echo REAL'), `base ${flag}`);
        candidate(dir, files('exit 0'));

        const resolution = resolve(dir, baseSha);

        expect(resolution.reason, flag).toBe('commands-changed-vs-base');
        expect(resolution.diff, flag).toContain('@@ script:inner @@');
      }
    });

    it('records an npm segment it cannot resolve instead of continuing silently', () => {
      for (const body of ['npm run', 'npm ci', 'npm --silent']) {
        baseSha = freeze(
          dir,
          { '.ai/agentic.config.json': config(['npm test']), 'package.json': pkg({ test: body }) },
          `base ${body}`,
        );

        const resolution = resolve(dir, baseSha);

        expect(resolution.status, body).toBe('resolved');
        expect(notes(resolution), body).toContain('dynamic npm-run reference');
        expect(notes(resolution), body).toContain(body);
        expect(notes(resolution), body).toContain('not pinned');
      }
    });

    it('records a dynamic npm reference in the command list itself — it was silent before', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm run "$TARGET"']),
        'package.json': pkg({ inner: 'echo REAL' }),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('$TARGET');
      expect(notes(resolution)).toContain('not pinned');
    });

    it('names a local script file a BODY names — the file content is not pinned, and the note says so', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: './scripts/run.sh' }),
        'scripts/run.sh': 'echo REAL\n',
      });

      const resolution = resolve(dir, baseSha);

      // Still resolved (only argv files are pinned), but the residual is named.
      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('names the local script file scripts/run.sh — its body is not pinned');
    });
  });

  describe('the `--` boundary, --ws and the candidate’s own manifest set (PR 3.4)', () => {
    it('reads a forwarded -w as an argument: the ROOT script is pinned, and its neutering drifts (F1)', () => {
      const files = (root: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --silent -- -w @scope/a', inner: root }),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
      });
      baseSha = freeze(dir, files('echo ROOT-REAL'));
      // npm 11.19.0 runs the ROOT `inner` here (`-w @scope/a` is forwarded as an
      // argument); the resolver used to pin the workspace script and drop the root one.
      candidate(dir, files('echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
      expect(resolution.diff).toContain('- echo ROOT-REAL');
      expect(resolution.diff).toContain('+ echo ROOT-NEUTERED');
      expect(notes(resolution)).not.toContain('workspace "@scope/a"');
    });

    it('reads a forwarded -w after the test verb the same way (F1)', () => {
      const files = (test: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm run probe']),
        'package.json': workspaceRoot({ probe: 'npm test -- -w @scope/a', test }),
        'packages/a/package.json': pkgNamed('@scope/a', { test: 'echo WS-A' }),
      });
      baseSha = freeze(dir, files('echo ROOT-TEST'));
      candidate(dir, files('exit 0'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:test @@');
      expect(resolution.diff).toContain('+ exit 0');
    });

    it('pins the root script behind a `--` before the verb — npm consumes it (guard)', () => {
      const files = (inner: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm -- run inner']),
        'package.json': pkg({ inner }),
      });
      baseSha = freeze(dir, files('echo REAL'));
      candidate(dir, files('exit 0'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
    });

    it('recognizes --ws as npm’s abbreviation of --workspaces: a neutered workspace script drifts (F2)', () => {
      const files = (second: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --ws', inner: 'echo ROOT' }),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
        'packages/b/package.json': pkgNamed('@scope/b', { inner: second }),
      });
      baseSha = freeze(dir, files('echo WS-B-REAL'));
      // npm 11.19.0 runs `inner` in EVERY workspace for `--ws`; the resolver used to
      // skip the token and pin only the root script, which npm does not run.
      candidate(dir, files('echo WS-B-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ workspace:packages/b/package.json#inner @@');
      expect(notes(resolution)).toContain('npm --workspaces → packages/a/package.json, packages/b/package.json');
    });

    it('reads --ws=<anything but false> as every workspace — npm’s boolean coercion (guard)', () => {
      const files = (second: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --ws=0', inner: 'echo ROOT' }),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
        'packages/b/package.json': pkgNamed('@scope/b', { inner: second }),
      });
      baseSha = freeze(dir, files('echo WS-B-REAL'));
      candidate(dir, files('echo WS-B-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ workspace:packages/b/package.json#inner @@');
    });

    it('treats a false workspace value as the root script — npm runs the root (guard)', () => {
      const files = (root: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --ws=false', inner: root }),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
      });
      baseSha = freeze(dir, files('echo ROOT-REAL'));
      candidate(dir, files('echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
      expect(resolution.diff).not.toContain('workspace:');
    });

    it('records an unmodelled npm flag before the verb instead of skipping it silently', () => {
      const files = (inner: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'npm --work run inner', inner }),
      });
      baseSha = freeze(dir, files('echo REAL'));
      candidate(dir, files('exit 0'));

      const resolution = resolve(dir, baseSha);

      // npm 11.19.0 warns "Unknown cli config" for `--work` and runs the root script;
      // an unmodelled flag's arity is unknowable here, so the plan says what it is not
      // pinning instead of guessing at the verb behind it.
      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('npm --work run inner');
      expect(notes(resolution)).toContain('not pinned');
    });

    it('refuses a candidate that ADDS a workspace manifest under unchanged globs — npm --workspaces runs it (F3)', () => {
      const files = (extra: boolean): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --workspaces' }, ['packages/*']),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
        ...(extra ? { 'packages/b/package.json': pkgNamed('@scope/b', { inner: 'echo WS-B-NEW' }) } : {}),
      });
      baseSha = freeze(dir, files(false));
      // npm 11.19.0 runs the added manifest's `inner` under `--workspaces`; the plan
      // read only the frozen base's manifest paths, so the addition was invisible.
      candidate(dir, files(true));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.changedVsBase).toBe(true);
      expect(resolution.diff).toContain('@@ workspace-manifests @@');
      expect(resolution.diff).toContain('+ packages/b/package.json');
      expect(commands(resolution)).toEqual([]);
    });

    it('does not refuse a manifest the globs do not name — the set is glob-resolved (guard)', () => {
      const files = (extra: boolean): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --workspaces' }, ['packages/*']),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
        ...(extra ? { 'vendor/b/package.json': pkgNamed('@scope/b', { inner: 'echo WS-B' }) } : {}),
      });
      baseSha = freeze(dir, files(false));
      candidate(dir, files(true));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
    });

    it('pins the ROOT script too when --include-workspace-root runs it alongside the delegation', () => {
      const files = (root: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --workspaces --include-workspace-root', inner: root }),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
      });
      baseSha = freeze(dir, files('echo ROOT-REAL'));
      // npm 11.19.0 runs ROOT *and* every workspace for this pair; pinning only the
      // workspace left the root body unpinned.
      candidate(dir, files('echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
    });

    it('records a --prefix that names another tree instead of pinning this tree’s body', () => {
      const files = (inner: string): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'npm --prefix ./other run inner', inner }),
      });
      baseSha = freeze(dir, files('echo REAL'));
      candidate(dir, files('exit 0'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('not pinned');
    });
  });

  describe('the npm flag scan — end-of-options, quoting and last-wins (PR 3.5)', () => {
    /**
     * A root manifest whose `probe` body spells the invocation under test, plus a
     * workspace manifest a delegation could resolve to. The base carries
     * `echo ROOT-REAL`; a candidate neuters the ROOT body, so a plan that does not
     * pin it stays `resolved` while npm runs the neutered one.
     */
    const fixture = (probe: string, rootInner = 'echo ROOT-REAL', workspace: Record<string, string> = {}): Record<string, string> => ({
      '.ai/agentic.config.json': config(['npm run probe']),
      'package.json': workspaceRoot({ probe, inner: rootInner }),
      'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A', ...workspace }),
    });

    it('runs the ROOT body when `--` precedes the VERB — the trailing --ws is an argument (H1)', () => {
      const probe = 'npm -- run inner --ws';
      baseSha = freeze(dir, fixture(probe));
      // npm 11.19.0: `npm -- run inner --ws` prints `ROOT-REAL --ws` (the `--` stops
      // npm's own option parsing; `--ws` is forwarded to the ROOT script).
      candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
      expect(resolution.diff).toContain('- echo ROOT-REAL');
      expect(resolution.diff).toContain('+ echo ROOT-NEUTERED');
      expect(notes(resolution)).not.toContain('the delegated "inner" script is pinned');
    });

    it('runs the ROOT body when `--` precedes the SCRIPT NAME (H1)', () => {
      const probe = 'npm run -- inner --ws';
      baseSha = freeze(dir, fixture(probe));
      // npm 11.19.0: `npm run -- inner --ws` prints `ROOT-REAL --ws` — `inner` is the
      // script, `--ws` is an argument, and no workspace is selected.
      candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
      expect(notes(resolution)).not.toContain('the delegated "inner" script is pinned');
    });

    it('runs the ROOT body when `--` precedes the verb and `-w` follows (H1)', () => {
      const probe = 'npm -- run inner -w @scope/a';
      baseSha = freeze(dir, fixture(probe));
      // npm 11.19.0: `npm -- run inner -w @scope/a` prints `ROOT-REAL -w @scope/a`.
      candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
      expect(notes(resolution)).not.toContain('the delegated "inner" script is pinned');
    });

    it('keeps an earlier workspace selection when `--` ends the options before the verb (guard)', () => {
      const probe = 'npm -w @scope/a -- run inner';
      baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
      // npm 11.19.0: the `-w` config is parsed before the `--` and still applies —
      // `WS-A-REAL` runs; the root body does not.
      candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
    });

    it("reads a quoted false workspace value as the ROOT — the shell strips the quotes (H2)", () => {
      for (const probe of ["npm run inner --ws='false'", 'npm run inner --ws="false"']) {
        baseSha = freeze(dir, fixture(probe), `base ${probe}`);
        // npm 11.19.0: the shell hands npm `--ws=false`, so the ROOT `inner` runs.
        candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status, probe).toBe('nothing-to-check');
        expect(resolution.reason, probe).toBe('commands-changed-vs-base');
        expect(resolution.diff, probe).toContain('@@ script:inner @@');
        expect(notes(resolution), probe).not.toContain('the delegated "inner" script is pinned');
      }
    });

    it("reads a quoted false --include-workspace-root as off — the root does not run (H2 twin)", () => {
      const probe = "npm run inner --workspaces --include-workspace-root='false'";
      baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
      // npm 11.19.0 runs every workspace's `inner`, NOT the root body, so the root
      // body is not part of the plan.
      candidate(dir, fixture(probe, 'echo ROOT-NEUTERED', { inner: 'echo WS-A-REAL' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(resolution.diff).toBe('');
    });

    it('keeps a quoted non-false value on — one matching quote pair is stripped, nothing else (guard)', () => {
      const probe = "npm run inner --ws='0'";
      baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
      // npm 11.19.0 reads `--ws='0'` as `--ws=0`: every workspace runs (`WS-A-REAL 0`);
      // only the exact value `false` turns the flag off.
      candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
      expect(notes(resolution)).toContain('npm --workspaces → packages/a/package.json');
    });

    it('resolves a quoted --workspace selector — the shell strips the quotes (H2)', () => {
      const probe = "npm run inner --workspace='@scope/a'";
      baseSha = freeze(dir, fixture(probe, 'echo ROOT', { inner: 'echo WS-A-REAL' }));
      // npm 11.19.0: `--workspace='@scope/a'` IS `--workspace=@scope/a` — `WS-A-REAL` runs.
      candidate(dir, fixture(probe, 'echo ROOT', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
      expect(notes(resolution)).not.toContain('no workspace manifest named or at');
    });

    it('makes the LAST workspace flag win — a final false clears the delegation (H3)', () => {
      for (const probe of ['npm run inner --ws --ws=false', 'npm run inner --ws=0 --ws=false']) {
        baseSha = freeze(dir, fixture(probe), `base ${probe}`);
        // npm 11.19.0: both spellings run the ROOT `inner` (the boolean is last-wins,
        // and only `false` turns the all-workspaces form off).
        candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status, probe).toBe('nothing-to-check');
        expect(resolution.diff, probe).toContain('@@ script:inner @@');
        expect(notes(resolution), probe).not.toContain('the delegated "inner" script is pinned');
      }
    });

    it('lets a later all-workspaces flag turn the delegation back on (guard)', () => {
      const probe = 'npm run inner --ws=false --ws';
      baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
      // npm 11.19.0: every workspace runs; the root does not.
      candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
    });

    it('records a selector beside a false boolean instead of pinning a body npm refuses to run (H3)', () => {
      const probe = 'npm run inner -w @scope/a --ws=false';
      baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
      // npm 11.19.0 exits 1: "Cannot use --no-workspaces and --workspace at the same
      // time" — nothing runs, so nothing may be claimed as pinned.
      candidate(dir, fixture(probe, 'echo ROOT-NEUTERED', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('not pinned');
      expect(notes(resolution)).not.toContain('the delegated "inner" script is pinned');
    });

    it('keeps the root pin on a repeated --include-workspace-root (safe-direction guard)', () => {
      const probe = 'npm run inner --workspaces --include-workspace-root --include-workspace-root=false';
      baseSha = freeze(dir, fixture(probe));
      // npm 11.19.0's last-wins false runs only the workspaces; this scan keeps the
      // root pinned anyway — over-pinning refuses a root-body move, never misses one.
      candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ script:inner @@');
    });

    it('refuses when the candidate reorders the "workspaces" array — conservative by design (guard)', () => {
      const shapes = (workspaces: string[]): Record<string, string> => ({
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': workspaceRoot({ test: 'npm run inner --workspaces' }, workspaces),
        'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A' }),
      });
      baseSha = freeze(dir, shapes(['packages/*', 'apps/*']));
      // A reorder resolves the same manifest set, but it moves the field npm reads at
      // run time — the safe direction is to refuse, not to guess it is a no-op.
      candidate(dir, shapes(['apps/*', 'packages/*']));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.reason).toBe('commands-changed-vs-base');
      expect(resolution.diff).toContain('@@ workspaces @@');
      expect(resolution.diff).toContain('- "packages/*"');
    });

    it('records a shell-escaped `--` after the script name instead of delegating past it (H4)', () => {
      const probe = 'npm run inner \\-- -w @scope/a';
      baseSha = freeze(dir, fixture(probe));
      // The shell turns `\--` into `--`: npm runs the ROOT body with `-w @scope/a` as
      // an ARGUMENT. A scan that skips the escaped token silently pinned the workspace.
      candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('not pinned');
      expect(notes(resolution)).not.toContain('the delegated "inner" script is pinned');
    });

    it('records a variable expansion after the script name instead of pinning the root silently (H4)', () => {
      const probe = 'SEP=--ws; npm run inner "$SEP"';
      baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
      // npm 11.19.0 expands `$SEP` to `--ws`: EVERY workspace's `inner` runs, while
      // the scan pinned only the root body — and emitted no note at all.
      candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('$SEP');
      expect(notes(resolution)).toContain('not pinned');
      expect(notes(resolution)).not.toContain('the delegated "inner" script is pinned');
    });
  });

  describe('nested shell wrappers and --no-workspaces (PR 3.6)', () => {
    /**
     * The 3.5 fixture, reused: a root `probe` body spells the invocation under
     * test, a root `inner` body is what a wrapper can reach, and a workspace
     * manifest is what a delegation resolves to. The base carries `echo ROOT-REAL`
     * / `echo WS-A-REAL`; a candidate neuters one of them, so a plan that does not
     * pin that body stays `resolved` while npm runs the neutered one.
     */
    const fixture = (probe: string, rootInner = 'echo ROOT-REAL', workspace: Record<string, string> = {}): Record<string, string> => ({
      '.ai/agentic.config.json': config(['npm run probe']),
      'package.json': workspaceRoot({ probe, inner: rootInner }),
      'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A-REAL', ...workspace }),
    });

    describe('a `-c` shell string is scanned as a command line (F1)', () => {
      it('pins the workspace body behind `sh -c "npm run inner --ws"` — npm runs it (F1)', () => {
        const probe = 'sh -c "npm run inner --ws"';
        baseSha = freeze(dir, fixture(probe));
        // npm 11.19.0: `sh -c "npm run inner --ws"` prints WS-A-REAL then WS-B-REAL —
        // the workspace bodies run, so a candidate that neuters WS-A is drift.
        candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.reason).toBe('commands-changed-vs-base');
        expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
        expect(resolution.diff).toContain('- echo WS-A-REAL');
        expect(resolution.diff).toContain('+ echo WS-A-NEUTERED');
      });

      it('pins a `-c` string in every measured wrapper spelling — quotes and flag clusters do not hide it (F1)', () => {
        for (const probe of [
          'sh -c "npm run inner"',
          "sh -c 'npm run inner'",
          'bash -c "npm run inner"',
          'sh -ec "npm run inner"',
          'bash -o pipefail -c "npm run inner"',
          'bash -O extglob -c "npm run inner"',
          'bash --rcfile /dev/null -c "npm run inner"',
        ]) {
          baseSha = freeze(dir, fixture(probe), `base ${probe}`);
          // npm 11.19.0: every spelling runs the ROOT `inner` body (the argument is
          // a command line, whatever flags precede `-c`).
          candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

          const resolution = resolve(dir, baseSha);

          expect(resolution.status, probe).toBe('nothing-to-check');
          expect(resolution.diff, probe).toContain('@@ script:inner @@');
        }
      });

      it('pins a wrapper’s inner invocation inside a script BODY too — the closure scans bodies (F1)', () => {
        const shape = (neuter: boolean): Record<string, string> => ({
          '.ai/agentic.config.json': config(['npm run gate']),
          'package.json': workspaceRoot({ gate: 'sh -c "npm run inner --ws"', inner: 'echo ROOT-REAL' }),
          'packages/a/package.json': pkgNamed('@scope/a', { inner: neuter ? 'echo WS-A-NEUTERED' : 'echo WS-A-REAL' }),
        });
        baseSha = freeze(dir, shape(false));
        // npm 11.19.0: the body runs the workspace bodies; a body-level wrapper is
        // the same hole one hop deeper.
        candidate(dir, shape(true));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
      });

      it('pins a wrapper in the command list itself — the same scan, one hop shallower (F1)', () => {
        const command = 'sh -c "npm run inner --ws"';
        const shape = (neuter: boolean): Record<string, string> => ({
          '.ai/agentic.config.json': config([command]),
          'package.json': workspaceRoot({ inner: 'echo ROOT-REAL' }),
          'packages/a/package.json': pkgNamed('@scope/a', { inner: neuter ? 'echo WS-A-NEUTERED' : 'echo WS-A-REAL' }),
        });
        baseSha = freeze(dir, shape(false));
        // npm 11.19.0: the command list entry runs the workspace bodies too; a fix
        // that only scanned script bodies would leave this spelling silent.
        candidate(dir, shape(true));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
      });

      it('records a wrapper whose script string it cannot model — never silent (F1)', () => {
        baseSha = freeze(dir, fixture('sh -c "$CMD"'));
        // The script string is computed at run time: whether npm runs at all (and
        // with which flags) is unknowable here, so the segment must be NAMED, not
        // silently skipped.
        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('resolved');
        expect(notes(resolution)).toContain('dynamic npm-run reference');
        expect(notes(resolution)).toContain('sh -c $CMD');
        expect(notes(resolution)).toContain('not pinned');
      });

      it('names the wrapper when its inner npm invocation cannot be modelled (F1)', () => {
        baseSha = freeze(dir, fixture('sh -c "npm run $TARGET"'));
        // `npm run $TARGET` names a script this scan cannot read; the note names the
        // WRAPPER, so a reader can see where the unpinnable invocation hides.
        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('resolved');
        expect(notes(resolution)).toContain('dynamic npm-run reference');
        expect(notes(resolution)).toContain('sh -c npm run $TARGET');
        expect(notes(resolution)).toContain('not pinned');
      });

      it('leaves a wrapper with no npm inside it alone — no note, no pin (guard)', () => {
        baseSha = freeze(dir, fixture('sh -c "echo hi"'));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('resolved');
        expect(notes(resolution)).not.toContain('dynamic npm-run reference');
      });
    });

    describe('--no-workspaces is npm’s boolean-false spelling (F2)', () => {
      it('runs the ROOT body for `--no-workspaces` — the negated boolean (F2)', () => {
        const probe = 'npm run inner --no-workspaces';
        baseSha = freeze(dir, fixture(probe));
        // npm 11.19.0: prints ROOT-REAL — `--no-workspaces` IS `--workspaces=false`,
        // so the ROOT body runs and a neutered ROOT is drift.
        candidate(dir, fixture(probe, 'echo ROOT-NEUTERED'));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.reason).toBe('commands-changed-vs-base');
        expect(resolution.diff).toContain('@@ script:inner @@');
        expect(notes(resolution)).not.toContain('dynamic npm-run reference');
      });

      it('reads `--no-workspaces=false` as every workspace — the negation of false (F2)', () => {
        const probe = 'npm run inner --no-workspaces=false';
        baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
        // npm 11.19.0: prints WS-A-REAL and WS-B-REAL — the negation of false leaves
        // every workspace selected; the ROOT does not run.
        candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
      });

      it('reads the separate `--no-workspaces false` token as the negated value too (F2)', () => {
        const probe = 'npm run inner --no-workspaces false';
        baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
        // npm 11.19.0: the `false` token is consumed as the flag's value, and the
        // negation of false is on — every workspace runs.
        candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
      });

      it('keeps last-wins across --ws and --no-workspaces — the same npm config key (F2)', () => {
        const cases = [
          { probe: 'npm run inner --no-workspaces --ws', neuterRoot: false, section: '@@ workspace:packages/a/package.json#inner @@' },
          { probe: 'npm run inner --ws --no-workspaces', neuterRoot: true, section: '@@ script:inner @@' },
        ];
        for (const { probe, neuterRoot, section } of cases) {
          baseSha = freeze(dir, fixture(probe), `base ${probe}`);
          // npm 11.19.0: the last spelling wins — `--... --ws` runs WS-A + WS-B,
          // `--ws --no-workspaces` runs the ROOT only.
          candidate(dir, neuterRoot ? fixture(probe, 'echo ROOT-NEUTERED') : fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

          const resolution = resolve(dir, baseSha);

          expect(resolution.status, probe).toBe('nothing-to-check');
          expect(resolution.diff, probe).toContain(section);
        }
      });

      it('records --no-workspaces beside a -w selector instead of pinning a body npm refuses to run (F2 guard)', () => {
        const probe = 'npm run inner -w @scope/a --no-workspaces';
        baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
        // npm 11.19.0 exits 1: "Cannot use --no-workspaces and --workspace at the
        // same time" — nothing runs, so nothing may be claimed as pinned.
        candidate(dir, fixture(probe, 'echo ROOT-NEUTERED', { inner: 'echo WS-A-NEUTERED' }));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('resolved');
        expect(notes(resolution)).toContain('dynamic npm-run reference');
        expect(notes(resolution)).not.toContain('the delegated "inner" script is pinned');
      });

      it('keeps the selector when `--no-workspaces=false` turns the boolean back on (F2 guard)', () => {
        const probe = 'npm run inner --no-workspaces=false -w @scope/a';
        baseSha = freeze(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-REAL' }));
        // npm 11.19.0: WS-A-REAL only — a selector wins over an on boolean, whatever
        // spelling turned it on.
        candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
      });
    });
  });

  describe('shell program basenames, `env` prefixes and the `-c --` spelling (PR 3.7)', () => {
    /**
     * The 3.6 fixture, reused: a root `probe` body spells the invocation under
     * test, a root `inner` body is what a wrapper can reach, and a workspace
     * manifest is what a delegation resolves to. The base carries `echo ROOT-REAL`
     * / `echo WS-A-REAL`; a candidate neuters one of them, so a plan that does not
     * pin that body stays `resolved` while npm runs the neutered one.
     */
    const fixture = (probe: string, rootInner = 'echo ROOT-REAL', workspace: Record<string, string> = {}): Record<string, string> => ({
      '.ai/agentic.config.json': config(['npm run probe']),
      'package.json': workspaceRoot({ probe, inner: rootInner }),
      'packages/a/package.json': pkgNamed('@scope/a', { inner: 'echo WS-A-REAL', ...workspace }),
    });

    /**
     * The base runs WS-A through the spelling under test (measured against npm
     * 11.19.0), so a candidate that neuters WS-A has moved what runs: the plan
     * must pin the delegated body, not stay `resolved` on it.
     */
    const expectDelegationPinned = (probe: string): void => {
      baseSha = freeze(dir, fixture(probe), `base ${probe}`);
      candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status, probe).toBe('nothing-to-check');
      expect(resolution.reason, probe).toBe('commands-changed-vs-base');
      expect(resolution.diff, probe).toContain('@@ workspace:packages/a/package.json#inner @@');
    };

    it('matches the shell by BASENAME — `/bin/sh -c` and `/usr/bin/sh -c` ran the string all along (F1r)', () => {
      // npm 11.19.0: each spelling prints WS-A-REAL — the shell is found through
      // PATH, so the program token is the PATH's last segment, not the literal `sh`
      // the old verbatim check compared against.
      for (const probe of [
        '/bin/sh -c "npm run inner --ws"',
        '/usr/bin/sh -c "npm run inner --ws"',
        '/bin/bash -c "npm run inner --ws"',
      ]) {
        expectDelegationPinned(probe);
      }
    });

    it('skips ONE `--` between `-c` and the string — bare and path forms, clusters included (F1s)', () => {
      // npm 11.19.0: `sh -c -- "npm run inner --ws"` prints WS-A-REAL — the `--` is
      // the shell's own end-of-options, not the string. (A SECOND `--` is the
      // string: `sh -c -- -- 'echo hi'` tries to run the command `--`.)
      for (const probe of [
        'sh -c -- "npm run inner --ws"',
        'bash -c -- "npm run inner --ws"',
        'dash -c -- "npm run inner --ws"',
        'sh -ec -- "npm run inner --ws"',
        '/bin/sh -c -- "npm run inner --ws"',
      ]) {
        expectDelegationPinned(probe);
      }
    });

    it('resolves an `env` prefix to its COMMAND operand — options, assignments and `--` skipped (F1r, env)', () => {
      // coreutils 9.4 + npm 11.19.0: every spelling below runs the wrapper. `-i`
      // is modelled as a prefix (the scan reads the COMMAND LINE; that an empty
      // environment then cannot resolve npm on PATH is outside the argv model, and
      // an over-pin is the safe direction).
      for (const probe of [
        '/usr/bin/env sh -c "npm run inner --ws"',
        'env -i sh -c "npm run inner --ws"',
        'env -u FOO /bin/sh -c "npm run inner --ws"',
        'env FOO=bar /bin/sh -c "npm run inner --ws"',
        'env -- /bin/sh -c "npm run inner --ws"',
        'env -C . /bin/sh -c "npm run inner --ws"',
      ]) {
        expectDelegationPinned(probe);
      }
    });

    it('reads `env -S`/`--split-string` as the command line coreutils splits it into (F1r, env)', () => {
      // coreutils 9.4: `-S` splits the string into the command and its arguments
      // and appends the rest of env's argv. `--spl`/`--s` are unambiguous
      // getopt_long abbreviations of `--split-string` and split too. Last row:
      // `env -S 'sh -c' 'npm run inner --ws'` completes the wrapper from the
      // appended argv (measured: the workspace bodies run).
      for (const probe of [
        'env -S \'sh -c "npm run inner --ws"\'',
        "env -S 'npm run inner --ws'",
        'env --split-string="npm run inner --ws"',
        "env --spl 'npm run inner --ws'",
        "env -vS 'npm run inner --ws'",
        "env -S 'sh -c' 'npm run inner --ws'",
        "env -S '-S \"npm run inner --ws\"'",
      ]) {
        expectDelegationPinned(probe);
      }
    });

    it('names a split string it cannot model — `env -S "$CMD"` — instead of going silent (F1r, env)', () => {
      const probe = 'env -S "$CMD"';
      baseSha = freeze(dir, fixture(probe));

      const resolution = resolve(dir, baseSha);

      expect(notes(resolution)).toContain('dynamic npm-run reference');
      expect(notes(resolution)).toContain('not pinned');
    });

    it('leaves `env -S` with no npm in it alone — no note, no pin (guard)', () => {
      const probe = "env -S 'echo hi'";
      baseSha = freeze(dir, fixture(probe));
      // coreutils 9.4: `env -S 'echo hi'` runs `echo hi` — nothing npm can run.

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).not.toContain('dynamic npm-run reference');
    });

    it('leaves `sh -c --` with nothing after the terminator alone — the shell exits 2 (guard)', () => {
      const probe = 'sh -c --';
      baseSha = freeze(dir, fixture(probe));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).not.toContain('dynamic npm-run reference');
    });

    it('leaves a PATH-named wrapper with no npm inside it alone (guard)', () => {
      const probe = '/bin/sh -c "echo hi"';
      baseSha = freeze(dir, fixture(probe));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).not.toContain('dynamic npm-run reference');
    });

    it('falls back to the ordinary token scan for an `env` option it does not model (guard)', () => {
      const probe = 'env --bogus sh -c "npm run inner --ws"';
      baseSha = freeze(dir, fixture(probe));
      // coreutils 9.4: an unknown option exits 125 before any command runs, so
      // nothing can hide behind it; the tokens are still read by the ordinary
      // scan, which finds the wrapper — over-pinning, never a silent skip.
      candidate(dir, fixture(probe, 'echo ROOT-REAL', { inner: 'echo WS-A-NEUTERED' }));

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('nothing-to-check');
      expect(resolution.diff).toContain('@@ workspace:packages/a/package.json#inner @@');
    });
  });

  describe('the install lifecycle — npm 11’s full set (F2)', () => {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
      it(`pins the lifecycle hook the install step runs: ${hook}`, () => {
        const withHook = (body: string): Record<string, string> => ({
          '.ai/agentic.config.json': config(['npm test']),
          'package.json': pkg({ test: 'node t.js', [hook]: body }),
          [PACKAGE_LOCK_PATH]: '{}\n',
        });
        baseSha = freeze(dir, withHook('node hook.js'));
        candidate(dir, withHook('node hook-moved.js'));

        const resolution = resolve(dir, baseSha);

        expect(resolution.reason).toBe('commands-changed-vs-base');
        expect(resolution.diff).toContain(`@@ script:${hook} @@`);
        expect(resolution.diff).toContain('+ node hook-moved.js');
      });
    }
  });

  describe('base reads that are not absence (F3)', () => {
    /** A narrow view of the mocked execFileSync, enough to inject one failure mode. */
    type ExecMock = {
      getMockImplementation(): ((...args: unknown[]) => unknown) | undefined;
      mockImplementation(fn: (program: string, args: string[], options?: unknown) => unknown): void;
    };
    const execMock = (): ExecMock => vi.mocked(execFileSync) as unknown as ExecMock;

    const failRead = (path: string, code: string, status: number | null): (() => void) => {
      const mock = execMock();
      const original = mock.getMockImplementation();
      mock.mockImplementation((program, args, options) => {
        if (program === 'git' && args[0] === 'show' && String(args[1]).endsWith(`:${path}`)) {
          const failure = new Error(`spawnSync git ${code}`) as NodeJS.ErrnoException & { status?: number | null };
          failure.code = code;
          failure.status = status;
          throw failure;
        }
        return original?.(program, args, options);
      });
      return () => mock.mockImplementation(original!);
    };

    it('reads a Makefile larger than the old 16 MiB buffer instead of calling it absent', () => {
      const huge = `all:\n\t@echo ok\n${'# padding line for the buffer probe\n'.repeat(500_000)}`;
      expect(huge.length).toBeGreaterThan(16 * 1024 * 1024);
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['make test']),
        'package.json': pkg({}),
        [MAKEFILE_PATH]: huge,
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(resolution.makefile.present).toBe(true);
      expect(resolution.makefile.targets).toEqual(['all']);

      candidate(dir, { [MAKEFILE_PATH]: huge.replace('@echo ok', '@echo moved') });
      const drifted = resolve(dir, baseSha);

      expect(drifted.reason).toBe('commands-changed-vs-base');
      expect(drifted.diff).toContain(`@@ ${MAKEFILE_PATH} @@`);
    });

    it('a base file that fails with ENOBUFS is could-not-run, never absent', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['make test']),
        'package.json': pkg({}),
        [MAKEFILE_PATH]: 'all:\n',
      });
      const restore = failRead(MAKEFILE_PATH, 'ENOBUFS', 0);
      try {
        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('could-not-run');
        expect(resolution.reason).toBe('unreadable-source');
        expect(commands(resolution)).toEqual([]);
        expect(notes(resolution)).toContain('ENOBUFS');
      } finally {
        restore();
      }
    });

    it('an EACCES on the base lockfile is could-not-run, not a silent npm install', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm test']),
        'package.json': pkg({ test: 'vitest run' }),
        [PACKAGE_LOCK_PATH]: '{}\n',
      });
      const restore = failRead(PACKAGE_LOCK_PATH, 'EACCES', null);
      try {
        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('could-not-run');
        expect(resolution.reason).toBe('unreadable-source');
        expect(resolution.install.argv).toEqual([]);
        expect(resolution.install.because).toContain('EACCES');
      } finally {
        restore();
      }
    });

    it('exit 128 stays absence — a path the base does not carry is not an error', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['./scripts/gate.sh']),
        'package.json': pkg({}),
      });

      const resolution = resolve(dir, baseSha);

      expect(resolution.status).toBe('resolved');
      expect(notes(resolution)).not.toContain('could not be read');
    });

    it('an ENOBUFS on the workspace manifest behind a delegation is could-not-run, never a silent unpinned note', () => {
      baseSha = freeze(dir, {
        '.ai/agentic.config.json': config(['npm run test:unit']),
        'package.json': workspaceRoot({ 'test:unit': 'npm run test:unit -w @acme/pkg' }),
        'packages/pkg/package.json': pkgNamed('@acme/pkg', { 'test:unit': 'vitest run' }),
      });
      const restore = failRead('packages/pkg/package.json', 'ENOBUFS', 0);
      try {
        const resolution = resolve(dir, baseSha);

        expect(resolution.status).toBe('could-not-run');
        expect(resolution.reason).toBe('unreadable-source');
        expect(commands(resolution)).toEqual([]);
        expect(notes(resolution)).toContain('ENOBUFS');
      } finally {
        restore();
      }
    });
  });

  describe('explicit lists — supplied is not the same as non-empty (F4)', () => {
    it('a supplied-but-blank explicit list means nothing to check — it never falls through', () => {
      baseSha = freeze(dir, { 'package.json': pkg({ test: 'vitest run' }) });

      const absent = resolve(dir, baseSha);
      expect(absent.source).toBe('package-json');
      expect(absent.status).toBe('resolved');

      for (const list of [[''], []]) {
        const resolution = resolve(dir, baseSha, list);

        expect(resolution.status).toBe('nothing-to-check');
        expect(resolution.reason).toBe('no-commands');
        expect(resolution.source).toBe('explicit');
        expect(commands(resolution)).toEqual([]);
        expect(notes(resolution)).toContain('explicit: supplied but declares no command');
        expect(notes(resolution)).not.toContain('explicit: not supplied');
      }
    });
  });
});

describe('this repo’s own gate list', () => {
  /** `.ai/agentic.config.json` and `SDLC.md` § Validation gate describe the same
   *  process (`SDLC.md:93`) — a change to one without the other is a bug. */
  it('is the same list, in the same order, in .ai/agentic.config.json and SDLC.md', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const declared = JSON.parse(readFileSync(join(root, AGENTIC_CONFIG_PATH), 'utf8')) as { validation: { commands: string[] } };
    const sdlc = readFileSync(join(root, 'SDLC.md'), 'utf8').split('\n');

    const listed: string[] = [];
    let inSection = false;
    let seenIntro = false;
    for (const line of sdlc) {
      if (line.trim() === '## Validation gate') {
        inSection = true;
        continue;
      }
      if (inSection && line.startsWith('## ')) break;
      if (!inSection) continue;
      if (line.includes('in this order:')) {
        seenIntro = true;
        continue;
      }
      if (!seenIntro) continue;
      if (line.trim() === '') continue; // the blank line between the intro and the list
      const match = /^- `(.+)`\s*$/.exec(line);
      if (!match?.[1]) break;
      listed.push(match[1]);
    }

    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual(declared.validation.commands);
  });
});
