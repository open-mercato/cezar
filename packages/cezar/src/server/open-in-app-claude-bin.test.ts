import { describe, expect, it } from 'vitest';
import { withResolvedClaudeBin } from './open-in-app.ts';

/**
 * Detection (`detectOpenTargets`) finds a claude that is off this process's PATH, so the CLI
 * handoff is now OFFERED on those hosts. The terminal it opens is a different environment — a
 * non-interactive bash on Linux, a PATH-inheriting `cmd` on Windows — so unless the resolved
 * path travels with the command, the menu entry opens a window saying `command not found`.
 */
describe('withResolvedClaudeBin', () => {
  const RESOLVED = '/home/u/.local/bin/claude';

  it('names the resolved binary for a fresh claude launch', () => {
    expect(withResolvedClaudeBin('claude', 'claude', 'linux', RESOLVED)).toBe(`'${RESOLVED}'`);
  });

  it('keeps the --resume arguments while replacing only the binary', () => {
    expect(withResolvedClaudeBin('claude --resume ses_01ABC', 'claude', 'linux', RESOLVED))
      .toBe(`'${RESOLVED}' --resume ses_01ABC`);
  });

  it('leaves the command alone when claude is on PATH (nothing resolved beyond the bare name)', () => {
    expect(withResolvedClaudeBin('claude --resume ses_01ABC', 'claude', 'linux', null))
      .toBe('claude --resume ses_01ABC');
  });

  it('never rewrites another runner, even one whose command happens to mention claude', () => {
    expect(withResolvedClaudeBin('codex resume ses_01ABC', 'codex', 'linux', RESOLVED))
      .toBe('codex resume ses_01ABC');
  });

  it('does not rewrite a command that merely starts with the letters `claude`', () => {
    expect(withResolvedClaudeBin('claudex --resume x', 'claude', 'linux', RESOLVED))
      .toBe('claudex --resume x');
  });

  it('quotes a path containing spaces so the shell runs it as one word', () => {
    expect(withResolvedClaudeBin('claude', 'claude', 'linux', '/home/Jane Doe/.local/bin/claude'))
      .toBe("'/home/Jane Doe/.local/bin/claude'");
  });

  it('uses cmd.exe quoting on win32 rather than POSIX single quotes', () => {
    expect(withResolvedClaudeBin('claude', 'claude', 'win32', 'C:\\Program Files\\claude.exe'))
      .toBe('"C:\\Program Files\\claude.exe"');
  });
});
