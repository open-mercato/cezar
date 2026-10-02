import { describe, expect, it } from 'vitest';
import {
  pathDirsFromPathEnv,
  renderEnvPrefix,
  renderPathPrefix,
  shellQuote,
  withEnvPrefix,
  withPathPrefix,
} from './shell-env.ts';

/**
 * Rendering an agent account's config dir into a shell command (spec 2026-07-29-agent-profiles).
 *
 * The two properties worth pinning: the assignment must PERSIST for the session (the terminal
 * window stays open and the user types the next `claude` themselves), and an unrenderable value
 * must produce `null` rather than a best guess — a terminal silently pointed at the wrong account
 * is the failure this whole path exists to prevent.
 */
describe('renderEnvPrefix', () => {
  it('adds nothing for an empty env — the zero-config command is untouched', () => {
    expect(renderEnvPrefix({}, 'linux')).toBe('');
    expect(withEnvPrefix('claude --resume abc', {}, 'linux')).toBe('claude --resume abc');
  });

  it('exports on POSIX so the variable outlives the command', () => {
    expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz' }, 'darwin'))
      .toBe("export CLAUDE_CONFIG_DIR='/home/u/.claude-klaudiusz'; ");
  });

  it('uses `set` on Windows, where a POSIX assignment is meaningless', () => {
    expect(renderEnvPrefix({ CODEX_HOME: 'C:\\Users\\u\\codex-klaudiusz' }, 'win32'))
      .toBe('set "CODEX_HOME=C:\\Users\\u\\codex-klaudiusz" && ');
  });

  it('quotes a POSIX path containing spaces and single quotes', () => {
    expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: "/home/u/it's here" }, 'linux'))
      .toBe("export CLAUDE_CONFIG_DIR='/home/u/it'\\''s here'; ");
  });

  it('refuses control characters on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(renderEnvPrefix({ CLAUDE_CONFIG_DIR: `/home/u${String.fromCharCode(10)}evil` }, platform))
        .toBeNull();
    }
  });

  it('refuses cmd.exe metacharacters that have no escape inside a quoted `set`', () => {
    for (const bad of ['C:\\a"b', 'C:\\a%PATH%b', 'C:\\a!b!']) {
      expect(renderEnvPrefix({ CODEX_HOME: bad }, 'win32'), bad).toBeNull();
    }
    // The same paths are fine on POSIX, where single-quoting makes them inert — refusing them
    // there would be a limitation with no cause.
    for (const ok of ['C:\\a"b', 'C:\\a%PATH%b']) {
      expect(renderEnvPrefix({ CODEX_HOME: ok }, 'linux'), ok).not.toBeNull();
    }
  });

  it('refuses a name that is not a shell identifier', () => {
    expect(renderEnvPrefix({ 'NOT AN IDENT': '/x' }, 'linux')).toBeNull();
    expect(renderEnvPrefix({ '1LEADING': '/x' }, 'linux')).toBeNull();
  });

  it('renders several assignments in order', () => {
    expect(renderEnvPrefix({ A: '1', B: '2' }, 'linux')).toBe("export A='1'; export B='2'; ");
  });
});

describe('withEnvPrefix', () => {
  it('prefixes the command, or answers null when the env cannot be rendered', () => {
    expect(withEnvPrefix('claude --resume abc', { CLAUDE_CONFIG_DIR: '/w' }, 'linux'))
      .toBe("export CLAUDE_CONFIG_DIR='/w'; claude --resume abc");
    expect(withEnvPrefix('claude', { CLAUDE_CONFIG_DIR: 'a"b' }, 'win32')).toBeNull();
  });
});

describe('shellQuote', () => {
  it('makes every non-control character inert', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('a b$c`d')).toBe("'a b$c`d'");
  });
});

/**
 * The PATH half of a terminal handoff. The bug it exists for: a terminal emulator is
 * single-instance over D-Bus, so the window cezar opens inherits the RUNNING emulator's PATH, not
 * cezar's — and a CLI that only an interactive shell finds (`kilo` in `~/.kilo/bin`, added by a
 * `.bashrc` line) answers `command not found` for the command cezar itself just ran.
 *
 * Additive is the load-bearing property: the window keeps its own PATH and only gains ours, so a
 * narrower cezar environment cannot take a directory away from the user.
 */
describe('pathDirsFromPathEnv', () => {
  it('splits on the platform separator, dropping empties and repeats', () => {
    expect(pathDirsFromPathEnv('/usr/bin::/home/u/.kilo/bin:/usr/bin', 'linux'))
      .toEqual(['/usr/bin', '/home/u/.kilo/bin']);
    expect(pathDirsFromPathEnv(undefined, 'linux')).toEqual([]);
    expect(pathDirsFromPathEnv('', 'linux')).toEqual([]);
  });

  it('splits a win32 PATH on `;` so a drive letter is never mistaken for a separator', () => {
    expect(pathDirsFromPathEnv(String.raw`C:\Program Files\nodejs;C:\tools;D:\bin`, 'win32'))
      .toEqual([String.raw`C:\Program Files\nodejs`, String.raw`C:\tools`, String.raw`D:\bin`]);
  });
});

describe('renderPathPrefix', () => {
  it('prepends, keeping the PATH the window already has', () => {
    expect(renderPathPrefix(['/usr/bin', '/home/u/.kilo/bin'], 'linux'))
      .toBe('export PATH=\'/usr/bin\':\'/home/u/.kilo/bin\':"$PATH"; ');
  });

  it('uses `set "PATH=…;%PATH%"` on Windows, where `%PATH%` expands before the assignment', () => {
    expect(renderPathPrefix([String.raw`C:\tools`, String.raw`C:\Program Files\nodejs`], 'win32'))
      .toBe('set "PATH=C:\\tools;C:\\Program Files\\nodejs;%PATH%" && ');
  });

  it('answers null when there is nothing to add', () => {
    expect(renderPathPrefix([], 'linux')).toBeNull();
    expect(withPathPrefix('kilo auth login', [], 'linux')).toBeNull();
  });

  it('refuses control characters, and cmd metacharacters on win32 only', () => {
    const evil = `/home/u${String.fromCharCode(10)}evil`;
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(renderPathPrefix([evil], platform), platform).toBeNull();
    }
    expect(renderPathPrefix([String.raw`C:\a!b`], 'win32')).toBeNull();
    expect(renderPathPrefix([String.raw`C:\a!b`], 'linux')).not.toBeNull();
  });
});

describe('withPathPrefix', () => {
  it('prefixes the command, or answers null when no safe prefix exists', () => {
    expect(withPathPrefix('kilo auth login', ['/home/u/.kilo/bin'], 'linux'))
      .toBe('export PATH=\'/home/u/.kilo/bin\':"$PATH"; kilo auth login');
  });
});
