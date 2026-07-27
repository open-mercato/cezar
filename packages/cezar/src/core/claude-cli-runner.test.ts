import { describe, expect, it } from 'vitest';
import { prependSystemPrompt } from './agent-runner.js';
import { buildClaudeArgs } from './claude-cli-runner.js';

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
// Simulates the CLI bug: finishes a turn, then ignores stdin EOF and hangs
// until SIGTERMed — exiting 143 exactly like the real CLI does.
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
