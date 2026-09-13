import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { isSafeSessionId, resumeCommand } from './server.ts';

/**
 * Terminal take-over (#431): `resumeCommand`'s session id is the only variable
 * spliced into the command string that openInTerminal hands to bash (darwin),
 * a temp bash script (linux) or `cmd /K` (win32). Because cmd.exe has no
 * concept of `'`-quoting, the id is VALIDATED rather than quoted: recognised
 * ids go through verbatim (correct in every shell), anything else fails closed.
 */
describe('resumeCommand — session id validation', () => {
  it('splices a normal session id verbatim, per backend — no quoting in any shell', () => {
    const id = '9f8e7d6c-1234-4abc-9def-0123456789ab';
    expect(resumeCommand(undefined, id)).toBe(`claude --resume ${id}`);
    expect(resumeCommand('codex', id)).toBe(`codex resume ${id}`);
    expect(resumeCommand('opencode', id)).toBe(`opencode --session ${id}`);
    expect(resumeCommand('pi', id)).toBe(`pi --session ${id}`);
  });

  // Every runner id must map to a command — an id that fell through to the `claude` default
  // would hand the user a `claude --resume` for a session claude does not own (#387).
  it.each(RUNNER_IDS)('maps %s to its own CLI, never silently to claude', (runner) => {
    const id = '9f8e7d6c-1234-4abc-9def-0123456789ab';
    expect(resumeCommand(runner, id)?.startsWith(`${runner} `)).toBe(true);
  });

  it('never emits a quote character — a POSIX quote would reach cmd.exe literally on win32', () => {
    const cmd = resumeCommand('claude', 'ses_01ABC.def-42');
    expect(cmd).toBe('claude --resume ses_01ABC.def-42');
    expect(cmd).not.toContain("'");
    expect(cmd).not.toContain('"');
  });

  it('refuses a hostile-shaped id rather than escaping it', () => {
    expect(resumeCommand('claude', '$(touch /tmp/pwn); rm -rf ~ #')).toBeNull();
    expect(resumeCommand('claude', "a'b")).toBeNull();
    expect(resumeCommand('codex', 'a && calc.exe')).toBeNull();
    expect(resumeCommand('opencode', 'a`id`')).toBeNull();
    expect(resumeCommand('claude', 'a b')).toBeNull();
    expect(resumeCommand('claude', '')).toBeNull();
  });

  it('refuses an option-like id — `--resume -x` would be read as a flag', () => {
    expect(resumeCommand('claude', '-x')).toBeNull();
    expect(resumeCommand('claude', '--help')).toBeNull();
  });

  it('bounds the id length', () => {
    expect(isSafeSessionId('a'.repeat(200))).toBe(true);
    expect(isSafeSessionId('a'.repeat(201))).toBe(false);
  });

  it('accepts the shapes the backends actually mint', () => {
    for (const id of [
      '9f8e7d6c-1234-4abc-9def-0123456789ab',
      'ses_01JABCDEF',
      'session.2026-07-17',
    ]) {
      expect(isSafeSessionId(id)).toBe(true);
    }
  });
});
