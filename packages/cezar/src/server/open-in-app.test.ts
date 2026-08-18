import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so `spawnMock` is initialized before the (hoisted) vi.mock factory runs — the
// factory sets its default implementation, so a bare `const` would be read before init.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Default to an INERT child — nothing in this file needs a real process. `runDetached` only
  // touches `once`/`unref` before resolving true on its own settle timer, so a stub is enough to
  // exercise every launcher path. The previous default (delegate to the real spawn, so the
  // JetBrains case could execute stubs and read back their log) is what made that case flaky
  // (#823): it raced fork+exec latency, which is unbounded on a loaded host, against a fixed
  // poll budget. The openFileInDefaultApp arg-surface tests (#365) still override this per-test
  // with mockReturnValue in their own beforeEach.
  spawnMock.mockImplementation(() => ({ once: vi.fn(), unref: vi.fn() }));
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

import { RUNNER_IDS } from '../core/agent-runner.ts';

// This file is the one place allowed past the #824 spawn guard, and the reason is visible above:
// `spawn` is replaced file-wide by an inert stub, so no launcher call here reaches the OS. The
// exemption is still required because `refuseSpawnUnderTest` runs inside `runDetached` BEFORE
// `spawn`, so it trips on the mock exactly as it would on the real thing. Scoped to the file and
// restored afterwards, so no other suite inherits the exemption.
const savedAllowSpawn = process.env.CEZ_ALLOW_TEST_SPAWN;
beforeAll(() => {
  process.env.CEZ_ALLOW_TEST_SPAWN = '1';
});
afterAll(() => {
  if (savedAllowSpawn === undefined) delete process.env.CEZ_ALLOW_TEST_SPAWN;
  else process.env.CEZ_ALLOW_TEST_SPAWN = savedAllowSpawn;
});

import {
  agentCliRunner,
  detectOpenTargets,
  fileManagerLaunch,
  launchPathFor,
  openFileInDefaultApp,
  openInApp,
  resolveOnPath,
} from './open-in-app.ts';

describe('detectOpenTargets', () => {
  it('always offers a file manager and a terminal, first, both with an icon', () => {
    const targets = detectOpenTargets();
    expect(targets[0]).toMatchObject({ id: 'finder', icon: 'folder' });
    expect(targets[1]).toMatchObject({ id: 'terminal', icon: 'terminal' });
    // Ids are unique.
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
  });

  it('gives every detected target a non-empty icon key (#361)', () => {
    for (const target of detectOpenTargets()) {
      expect(target.icon, `${target.id} should carry an icon`).toBeTruthy();
    }
  });

  // Detection depends on what is actually installed, so the wider JetBrains registry (#361 gap
  // 3) is exercised by putting fake, executable stub binaries on PATH rather than asserting
  // against whatever happens to be present on the machine running the suite.
  describe('with stub CLIs on PATH', () => {
    let stubDir: string;
    let originalPath: string | undefined;

    const STUBS = ['idea', 'pycharm', 'webstorm', 'goland', 'rubymine', 'phpstorm', 'clion', 'rider', 'studio'];

    function withStubsOnPath() {
      stubDir = mkdtempSync(join(tmpdir(), 'cez-open-in-test-'));
      for (const name of STUBS) {
        const p = join(stubDir, name);
        // Marker files, not scripts: `resolveOnPath` probes them with `accessSync(X_OK)` and
        // nothing in this file executes them, because `spawn` is mocked file-wide.
        writeFileSync(p, '', 'utf8');
        chmodSync(p, 0o755);
      }
      originalPath = process.env.PATH;
      process.env.PATH = `${stubDir}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    }

    afterEach(() => {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      if (stubDir) rmSync(stubDir, { recursive: true, force: true });
    });

    it('detects every JetBrains product once its CLI launcher is on PATH', () => {
      withStubsOnPath();
      const targets = detectOpenTargets();
      const byId = new Map(targets.map((t) => [t.id, t]));

      expect(byId.get('idea')).toMatchObject({ label: 'IntelliJ IDEA', icon: 'idea' });
      expect(byId.get('pycharm')).toMatchObject({ label: 'PyCharm', icon: 'pycharm' });
      expect(byId.get('webstorm')).toMatchObject({ label: 'WebStorm', icon: 'webstorm' });
      expect(byId.get('goland')).toMatchObject({ label: 'GoLand', icon: 'goland' });
      expect(byId.get('rubymine')).toMatchObject({ label: 'RubyMine', icon: 'rubymine' });
      expect(byId.get('phpstorm')).toMatchObject({ label: 'PhpStorm', icon: 'phpstorm' });
      expect(byId.get('clion')).toMatchObject({ label: 'CLion', icon: 'clion' });
      expect(byId.get('rider')).toMatchObject({ label: 'Rider', icon: 'rider' });
      expect(byId.get('android-studio')).toMatchObject({ label: 'Android Studio', icon: 'android-studio' });
    });

    it('opens the resolved JetBrains stub with the worktree dir as its argument', async () => {
      withStubsOnPath();
      spawnMock.mockClear();

      expect(await openInApp('clion', '/tmp/some-worktree')).toBe(true);
      expect(await openInApp('rider', '/tmp/some-worktree')).toBe(true);

      // Read off the spawn seam rather than by executing the stubs and polling a log they append
      // to (#823). `runDetached` unrefs its child instead of waiting on it, so the log version
      // raced real fork+exec latency — unbounded on a loaded host, and measured at 2.1–2.6s
      // against a 2s poll budget — for no extra coverage: the recorded argv proves the same
      // property the log did, that the RESOLVED binary was launched with the worktree path,
      // while executing the stub only ever proved that bash works.
      const launched = spawnMock.mock.calls.map((call) => {
        const [bin, args] = call as [string, string[]];
        return { bin, args };
      });
      expect(launched).toEqual([
        { bin: 'clion', args: ['/tmp/some-worktree'] },
        { bin: 'rider', args: ['/tmp/some-worktree'] },
      ]);
      // Detached and stdio-free, which a launch must stay: an editor may outlive the cockpit and
      // must never inherit its stdio. Reading the stub's own log could not observe this at all.
      for (const call of spawnMock.mock.calls) {
        expect(call[2]).toMatchObject({ stdio: 'ignore', detached: true });
      }
    });
  });
});

describe('openInApp', () => {
  it('rejects an unknown target instead of launching anything', async () => {
    expect(await openInApp('not-a-real-editor', process.cwd())).toBe(false);
  });
});

/**
 * `openFileInDefaultApp`'s ARGUMENT SURFACE (#365). The path it receives is worktree content —
 * a filename some cloned repo or coding agent chose — so these tests pin the one property that
 * makes that safe: the filename is handed to the launcher as a single, un-re-parsed argument,
 * and never to a process that interprets shell metacharacters in its command line.
 */
describe('openFileInDefaultApp — the OS launcher argument surface', () => {
  const realPlatform = process.platform;
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  beforeEach(() => {
    spawnMock.mockReset();
    // A child that never errors: runDetached resolves true after its settle window.
    spawnMock.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
  });
  afterEach(() => setPlatform(realPlatform));

  // A name that is legal on NTFS and in git, and that clears the route's image allowlist.
  const HOSTILE = 'a&calc&.png';

  it('never routes a filename through cmd.exe on Windows (BatBadBut/CVE-2024-27980)', async () => {
    setPlatform('win32');
    await openFileInDefaultApp(`C:\\dev\\proj\\${HOSTILE}`);

    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    // cmd re-parses its command line, and libuv only quotes args containing space/tab/quote —
    // so `&` in a space-free path would survive into cmd and execute. Any launcher but cmd.
    expect(bin).not.toBe('cmd');
    expect(bin).toBe('explorer');
    // The whole path stays exactly one argv entry — never split, never interpolated.
    expect(args).toEqual([`C:\\dev\\proj\\${HOSTILE}`]);
  });

  it('passes the path as a lone argv entry on macOS and Linux too', async () => {
    for (const [platform, bin] of [
      ['darwin', 'open'],
      ['linux', 'xdg-open'],
    ] as const) {
      spawnMock.mockClear();
      setPlatform(platform);
      await openFileInDefaultApp(`/repo/${HOSTILE}`);

      const [calledBin, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(calledBin).toBe(bin);
      expect(args).toEqual([`/repo/${HOSTILE}`]);
    }
  });

  it('spawns without a shell, so no metacharacter is ever interpreted', async () => {
    setPlatform('linux');
    await openFileInDefaultApp('/repo/x.png');

    const opts = spawnMock.mock.calls[0]?.[2] as { shell?: unknown } | undefined;
    expect(opts?.shell).toBeFalsy();
  });
});

describe('resolveOnPath (#469 Windows launcher safety)', () => {
  let stubDir: string;

  afterEach(() => {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
    stubDir = '';
  });

  function addStub(name: string): void {
    stubDir ||= mkdtempSync(join(tmpdir(), 'cez-open-in-path-test-'));
    const stub = join(stubDir, name);
    writeFileSync(stub, '', 'utf8');
    chmodSync(stub, 0o755);
  }

  it('finds directly-spawnable .com and .exe launchers on native Windows and WSL', () => {
    addStub('editor.com');
    expect(resolveOnPath('editor', 'win32', false, stubDir)).toBe('editor.com');

    rmSync(join(stubDir, 'editor.com'));
    addStub('editor.exe');
    expect(resolveOnPath('editor', 'win32', false, stubDir)).toBe('editor.exe');
    expect(resolveOnPath('editor', 'linux', true, stubDir)).toBe('editor.exe');
  });

  it('does not offer .cmd or .bat shims that require a shell to execute', () => {
    addStub('editor.cmd');
    addStub('editor.bat');

    expect(resolveOnPath('editor', 'win32', false, stubDir)).toBeNull();
    expect(resolveOnPath('editor', 'linux', true, stubDir)).toBeNull();
  });

  it('prefers a WSL-native bare launcher over a Windows-side executable', () => {
    addStub('editor');
    addStub('editor.exe');
    expect(resolveOnPath('editor', 'linux', true, stubDir)).toBe('editor');
  });
});

describe('agentCliRunner', () => {
  // Driven off RUNNER_IDS, not a literal list, so runner #5 is covered the moment it is added
  // (the pi entry was missed on the hand-written list, #387 review).
  it.each(RUNNER_IDS)('maps cli:%s to that runner', (runner) => {
    expect(agentCliRunner(`cli:${runner}`)).toBe(runner);
  });

  it('rejects every id that is not a CLI handoff', () => {
    expect(agentCliRunner('vscode')).toBeNull();
    expect(agentCliRunner('terminal')).toBeNull();
    expect(agentCliRunner('cli:bogus')).toBeNull();
  });
});

describe('fileManagerLaunch (#361 WSL support)', () => {
  it('uses `open` on darwin and `explorer` on native win32, path unchanged', () => {
    expect(fileManagerLaunch('/repo/worktree', 'darwin', false)).toEqual({ bin: 'open', args: ['/repo/worktree'] });
    expect(fileManagerLaunch('C:\\repo\\worktree', 'win32', false)).toEqual({
      bin: 'explorer',
      args: ['C:\\repo\\worktree'],
    });
  });

  it('uses xdg-open on plain Linux (not WSL)', () => {
    expect(fileManagerLaunch('/home/pat/project', 'linux', false)).toEqual({
      bin: 'xdg-open',
      args: ['/home/pat/project'],
    });
  });

  it('goes through interop to explorer.exe under WSL, translating the POSIX path', () => {
    const result = fileManagerLaunch('/home/pat/project', 'linux', true);
    expect(result.bin).toBe('explorer.exe');
    // No real `wslpath` on the machine running this suite, so translateToWindowsPath falls back
    // to the pure conversion — still deterministic and worth pinning here.
    expect(result.args).toEqual(['\\\\wsl$\\Ubuntu\\home\\pat\\project']);
  });

  it('translates a WSL /mnt/<drive> path to its native Windows drive letter', () => {
    const result = fileManagerLaunch('/mnt/c/Users/pat/project', 'linux', true);
    expect(result.args).toEqual(['C:\\Users\\pat\\project']);
  });
});

describe('launchPathFor (#361 WSL support)', () => {
  it('passes the POSIX path through for a bare-name (WSL-native or non-WSL) binary', () => {
    expect(launchPathFor('idea', '/home/pat/project', true)).toBe('/home/pat/project');
    expect(launchPathFor('code', '/home/pat/project', false)).toBe('/home/pat/project');
  });

  it('translates the path for a Windows-suffixed binary resolved through WSL interop', () => {
    expect(launchPathFor('idea.exe', '/home/pat/project', true)).toBe('\\\\wsl$\\Ubuntu\\home\\pat\\project');
    expect(launchPathFor('pycharm.com', '/mnt/c/repo', true)).toBe('C:\\repo');
  });

  it('never translates when not running under WSL, even for a .exe name', () => {
    expect(launchPathFor('idea.exe', '/home/pat/project', false)).toBe('/home/pat/project');
  });
});
