import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so `spawnMock` is initialized before the (hoisted) vi.mock factory runs — the
// factory sets its default implementation, so a bare `const` would be read before init.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Default to the REAL spawn: the JetBrains stub test launches actual detached processes and
  // reads back their log. The openFileInDefaultApp arg-surface tests (#365) override this
  // per-test with mockReturnValue in their own beforeEach.
  spawnMock.mockImplementation((...args: unknown[]) =>
    (actual.spawn as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

import {
  agentCliRunner,
  detectOpenTargets,
  fileManagerLaunch,
  launchPathFor,
  openFileInDefaultApp,
  openInApp,
  resolveOnPath,
} from './open-in-app.js';

/** Polls `assertion` until it stops throwing or `timeoutMs` elapses (then rethrows) — there is
 *  no @testing-library here, and the detached child processes this suite launches settle on
 *  their own schedule, not the test's. */
async function waitFor(assertion: () => void, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

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

    let callLog: string;

    function withStubsOnPath() {
      stubDir = mkdtempSync(join(tmpdir(), 'cez-open-in-test-'));
      callLog = join(stubDir, 'calls.log');
      for (const name of STUBS) {
        const p = join(stubDir, name);
        // Records its own name and argv so the "opens with the right dir" test can confirm the
        // resolved binary actually ran with the worktree path, not just that spawn didn't throw.
        writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $1" >> ${JSON.stringify(callLog)}\ntrue\n`, 'utf8');
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
      expect(await openInApp('clion', '/tmp/some-worktree')).toBe(true);
      expect(await openInApp('rider', '/tmp/some-worktree')).toBe(true);
      // runDetached's own 250ms settle window is enough for these trivial scripts to run, but
      // it unrefs rather than waiting on the child — poll briefly rather than risk a flaky
      // exact-timing race under load.
      await waitFor(() => {
        const log = readFileSync(callLog, 'utf8');
        expect(log).toContain('clion /tmp/some-worktree');
        expect(log).toContain('rider /tmp/some-worktree');
      });
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
  it('maps cli:<runner> ids to the runner, and rejects everything else', () => {
    expect(agentCliRunner('cli:claude')).toBe('claude');
    expect(agentCliRunner('cli:codex')).toBe('codex');
    expect(agentCliRunner('cli:opencode')).toBe('opencode');
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
