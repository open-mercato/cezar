import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './agent-runner.js';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.js';
import { buildClaudeArgs, ClaudeCliRunner } from './claude-cli-runner.js';
import type { UiEvent } from './ui-events.js';

/**
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Extra rules.\n\n---\n\nContract.');
  });

  it('omits the flag entirely when no systemPrompt is set', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--append-system-prompt');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

/**
 * Turn-driven phase sessions (2026-07-24): with `autoEndAfterFirstTurn`
 * off, a session must survive a turn boundary, accept a follow-up message
 * (the phase nudge), run another turn, and close cleanly on `end()` — the
 * mechanics `runAgentStep` relies on to keep a phase's background subagents
 * alive across the boundary instead of killing them with the session.
 */
describe('ClaudeCliRunner turn-driven session', () => {
  it('runs a second turn from a message sent after the first turn ends', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ClaudeCliRunner } = await import('./claude-cli-runner.js');
    const dir = await mkdtemp(join(tmpdir(), 'cez-turns-'));
    try {
      const bin = join(dir, 'echo-claude.mjs');
      await writeFile(
        bin,
        `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 's-mt' });
let n = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {
  n += 1;
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn ' + n }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'turn ' + n, usage: { output_tokens: 1 } });
});
rl.on('close', () => process.exit(0));
`,
        { mode: 0o755 },
      );

      const runner = new ClaudeCliRunner({ bin, timeoutMs: 60_000 });
      const events: Array<{ type: string }> = [];
      let turnEnds = 0;
      const session = runner.startSession(
        { userPrompt: 'first', cwd: dir, sessionId: 's-mt' },
        (e) => {
          events.push(e);
          if (e.type === 'turn-end') {
            turnEnds += 1;
            if (turnEnds === 1) session.sendMessage([{ type: 'text', text: 'nudge: finish now' }]);
            if (turnEnds === 2) session.end();
          }
        },
        { autoEndAfterFirstTurn: false },
      );
      const result = await session.result;

      expect(turnEnds).toBe(2);
      expect(result.text).toContain('turn 1');
      expect(result.text).toContain('turn 2');
      expect(events.map((e) => e.type)).not.toContain('error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * The EOF watchdog's kill must read as clean closure (2026-07-24, live
 * failure): a harness spec phase finished its turn, `end()` closed stdin, the
 * claude CLI ignored EOF (janitor-confirmed bug) and hung, the watchdog
 * SIGTERMed it — and the exit 143 failed a phase whose work had already
 * succeeded. The runner must deliver the result and note the cleanup kill,
 * never throw. Wall clock: the test rides the real EOF_TERM_GRACE_MS (8s).
 */
describe('ClaudeCliRunner EOF watchdog', () => {
  it('treats the watchdog kill of an EOF-ignoring CLI as clean closure, not a failure', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ClaudeCliRunner } = await import('./claude-cli-runner.js');
    const dir = await mkdtemp(join(tmpdir(), 'cez-eof-'));
    try {
      const bin = join(dir, 'stuck-claude.mjs');
      await writeFile(
        bin,
        `#!/usr/bin/env node
setInterval(() => {}, 60_000);
process.on('SIGTERM', () => process.exit(143));
process.stdin.resume();
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 's-eof' });
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'spec finished' }] } });
say({ type: 'result', subtype: 'success', is_error: false, result: 'spec finished', session_id: 's-eof', usage: { input_tokens: 10, output_tokens: 5 } });
`,
        { mode: 0o755 },
      );

      const runner = new ClaudeCliRunner({ bin, timeoutMs: 60_000 });
      const events: Array<{ type: string; message?: unknown }> = [];
      const result = await runner.run(
        { userPrompt: 'write the spec', cwd: dir, sessionId: 's-eof' },
        (e) => events.push(e as { type: string; message?: unknown }),
      );

      expect(result.text).toContain('spec finished');
      const types = events.map((e) => e.type);
      expect(types).toContain('turn-end');
      expect(types).toContain('done');
      expect(types).not.toContain('error');
      expect(events.some((e) => e.type === 'note' && String(e.message).includes('ignored EOF'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
