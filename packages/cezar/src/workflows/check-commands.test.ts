import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENTIC_CONFIG_PATH,
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
        'package.json': pkg({ test: 'vitest run' }),
        [MAKEFILE_PATH]: `${poison}-target:\n\t${poison}\n`,
      });
      candidate(dir, { '.ai/agentic.config.json': config([poison, 'npm test', 'false']) });
      const mocked = vi.mocked(execFileSync);
      mocked.mockClear();

      resolve(dir, baseSha);

      const calls = mocked.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [program, args] of calls) {
        expect(program).toBe('git');
        expect(['rev-parse', 'show']).toContain(Array.isArray(args) ? args[0] : undefined);
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
