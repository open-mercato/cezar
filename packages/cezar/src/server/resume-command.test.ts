import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { isSafeSessionId, quoteResumeBin, resumeCommand } from './server.ts';

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
    expect(resumeCommand('cursor', id)).toBe(`agent --resume ${id}`);
    expect(resumeCommand('pi', id)).toBe(`pi --session ${id}`);
  });

  // Every runner id must map to a command — an id that fell through to the `claude` default
  // would hand the user a `claude --resume` for a session claude does not own (#387). Cursor is
  // excluded from the generic `${runner} ` check: its CLI binary is `agent`, not `cursor` (the
  // specific assertion above covers it).
  it.each(RUNNER_IDS.filter((runner) => runner !== 'cursor'))(
    'maps %s to its own CLI, never silently to claude',
    (runner) => {
      const id = '9f8e7d6c-1234-4abc-9def-0123456789ab';
      expect(resumeCommand(runner, id)?.startsWith(`${runner} `)).toBe(true);
    },
  );

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

  it('honours CEZ_CURSOR_AGENT_BIN, matching the binary cursor-agent-runner.ts resolves', () => {
    const previous = process.env.CEZ_CURSOR_AGENT_BIN;
    process.env.CEZ_CURSOR_AGENT_BIN = '/opt/cursor/agent';
    try {
      expect(resumeCommand('cursor', 'ses_01JABCDEF')).toBe('/opt/cursor/agent --resume ses_01JABCDEF');
    } finally {
      if (previous === undefined) delete process.env.CEZ_CURSOR_AGENT_BIN;
      else process.env.CEZ_CURSOR_AGENT_BIN = previous;
    }
  });

  /**
   * `CEZ_CURSOR_AGENT_BIN` is a real filesystem path, unlike the session id — it is not
   * VALIDATED into a fixed charset, it is QUOTED, so both the common Windows shape
   * (`C:\Program Files\...`) and a hostile one are covered by separate cases.
   */
  describe('quoteResumeBin — the cursor binary override', () => {
    it('splices a plain bin verbatim — no quoting when none is needed', () => {
      expect(quoteResumeBin('agent')).toBe('agent');
      expect(quoteResumeBin('/opt/cursor/agent')).toBe('/opt/cursor/agent');
    });

    it('double-quotes a bin containing whitespace instead of splitting the shell word', () => {
      expect(quoteResumeBin('C:\\Program Files\\Cursor\\agent.exe')).toBe(
        '"C:\\Program Files\\Cursor\\agent.exe"',
      );
    });

    it('refuses a bin carrying a quote/expansion character rather than escaping it', () => {
      for (const bin of ['agent"; rm -rf ~ #', "agent' ; touch pwn", 'agent$(touch pwn)', 'agent`id`', 'agent%x%', 'agent!x!']) {
        expect(quoteResumeBin(bin)).toBeNull();
      }
    });

    it('propagates the refusal through resumeCommand — no take-over, not a broken shell', () => {
      const previous = process.env.CEZ_CURSOR_AGENT_BIN;
      process.env.CEZ_CURSOR_AGENT_BIN = 'agent"; rm -rf ~ #';
      try {
        expect(resumeCommand('cursor', 'ses_01JABCDEF')).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.CEZ_CURSOR_AGENT_BIN;
        else process.env.CEZ_CURSOR_AGENT_BIN = previous;
      }
    });

    it('wraps a space-carrying override end to end — the practical Windows shape', () => {
      const previous = process.env.CEZ_CURSOR_AGENT_BIN;
      process.env.CEZ_CURSOR_AGENT_BIN = 'C:\\Program Files\\Cursor\\agent.exe';
      try {
        expect(resumeCommand('cursor', 'ses_01JABCDEF')).toBe(
          '"C:\\Program Files\\Cursor\\agent.exe" --resume ses_01JABCDEF',
        );
      } finally {
        if (previous === undefined) delete process.env.CEZ_CURSOR_AGENT_BIN;
        else process.env.CEZ_CURSOR_AGENT_BIN = previous;
      }
    });
  });
});
