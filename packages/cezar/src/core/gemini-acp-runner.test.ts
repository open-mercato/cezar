import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { detectEnvironment } from './backend-detect.ts';
import { createRunner } from './runner-factory.ts';
import { GEMINI_AUTH_FAILURE_MESSAGE } from './gemini-ui-mapper.ts';
import { GeminiAcpRunner, buildGeminiArgs, geminiExitMessage } from './gemini-acp-runner.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * The `gemini` runner (#581, spec 2026-09-19-runner-seam-native-backends Phase 2 Step 4) over the
 * bundled `scripts/mock-gemini-acp.mjs`, whose frames mirror the real CLI's captured wire.
 */
const MOCK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mock-gemini-acp.mjs');

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cez-gemini-run-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function collect() {
  const events: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  return { events, ui, onEvent: (e: AgentEvent) => events.push(e), onUiEvent: (e: UiEvent) => ui.push(e) };
}

function waitFor(predicate: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolveWait();
      if (Date.now() - started > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('GeminiAcpRunner — one turn over the mock', () => {
  const saved = process.env.CEZ_DRY_RUN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
  });

  it('CEZ_DRY_RUN=1 swaps in the bundled mock and streams both protocols to one done', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const argsFile = join(cwd, 'args.json');
    const c = collect();
    const session = new GeminiAcpRunner().startSession(
      { userPrompt: 'fix the login redirect', systemPrompt: 'Be terse.', cwd, model: 'gemini-3-flash-preview', env: { CEZ_MOCK_GEMINI_ARGS_FILE: argsFile } },
      c.onEvent,
      { autoEndAfterFirstTurn: true, onUiEvent: c.onUiEvent },
    );
    const result = await session.result;

    const types = c.events.map((e) => e.type);
    expect(types).toContain('session');
    expect(types).toContain('text');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types).toContain('token-usage');
    expect(types.filter((t) => t === 'turn-end')).toHaveLength(1);
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(types).not.toContain('error');
    // The system prompt rides in the first message (no native channel), so the mock echoes the task.
    expect(result.text).toBe('Investigating: fix the login redirect');
    expect(result.tokensUsed).toBe(120);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // The auto permission start mode, the model, and a trusted workspace (the mock exits 55 otherwise).
    const spawned = JSON.parse(readFileSync(argsFile, 'utf8')) as { argv: string[]; trust: boolean };
    expect(spawned.argv).toEqual(['--acp', '--model', 'gemini-3-flash-preview', '--approval-mode', 'yolo']);
    expect(spawned.trust).toBe(true);

    expect(c.ui.slice(0, 2).map((e) => e.type)).toEqual(['session.started', 'turn.started']);
    expect(c.ui).toContainEqual(expect.objectContaining({ type: 'session.started', backend: 'gemini', model: 'gemini-3-flash-preview', cwd }));
    expect(c.ui).toContainEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn', usage: { input: 100, output: 20, total: 120 } });
    expect(c.ui.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
  });
});

describe('GeminiAcpRunner — session lifecycle', () => {
  it('follow-ups are further session/prompt calls on the same process, in order', async () => {
    const c = collect();
    const session = new GeminiAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'first', cwd }, c.onEvent, { onUiEvent: c.onUiEvent });
    const pid = session.pid;
    // Sent while the first turn may still be running: queued, never interleaved.
    expect(session.sendMessage([{ type: 'text', text: 'second' }])).toBe(true);
    await waitFor(() => c.events.filter((e) => e.type === 'turn-end').length === 2);
    session.end();
    const result = await session.result;
    expect(result.text).toBe('Investigating: firstInvestigating: second');
    expect(session.pid).toBe(pid);
    expect(c.ui.filter((e) => e.type === 'turn.completed').map((e) => (e as { turnId: string }).turnId)).toEqual(['turn_1', 'turn_2']);
    expect(c.ui).toContainEqual({ type: 'usage.updated', usage: { input: 200, output: 40, total: 240 } });
    expect(session.sendMessage([{ type: 'text', text: 'too late' }])).toBe(false);
  });

  it('Continue resumes with session/load and never re-renders the replayed history', async () => {
    const c = collect();
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const result = await new GeminiAcpRunner({ bin: MOCK })
      .startSession({ userPrompt: 'carry on', cwd, sessionId, resume: true }, c.onEvent, { autoEndAfterFirstTurn: true, onUiEvent: c.onUiEvent })
      .result;
    expect(result.sessionId).toBe(sessionId);
    expect(result.text).toBe('Investigating: carry on');
    expect(JSON.stringify(c.events)).not.toContain('an earlier answer');
    expect(JSON.stringify(c.ui)).not.toContain('an earlier answer');
    expect(c.events).toContainEqual({ type: 'session', sessionId });
  });

  it('starts a fresh session with a note when the agent does not advertise session/load', async () => {
    const c = collect();
    const result = await new GeminiAcpRunner({ bin: MOCK })
      .startSession(
        { userPrompt: 'carry on', cwd, sessionId: '11111111-2222-4333-8444-555555555555', resume: true, env: { CEZ_MOCK_GEMINI_NO_LOAD: '1' } },
        c.onEvent,
        { autoEndAfterFirstTurn: true },
      )
      .result;
    expect(result.sessionId).not.toBe('11111111-2222-4333-8444-555555555555');
    expect(c.events).toContainEqual({ type: 'note', message: 'Gemini CLI does not advertise session/load — starting a fresh session' });
  });

  it('answers a permission request allow_always with a note, and the turn continues (Q15)', async () => {
    const c = collect();
    const result = await new GeminiAcpRunner({ bin: MOCK })
      .startSession({ userPrompt: 'run it', cwd, env: { CEZ_MOCK_GEMINI_PERMISSION: '1' } }, c.onEvent, {
        autoEndAfterFirstTurn: true,
        onUiEvent: c.onUiEvent,
      })
      .result;
    expect(c.events).toContainEqual({
      type: 'note',
      message: 'Gemini asked permission for echo mock; auto-approved (allow_always) — cezar runs Gemini in auto mode',
    });
    expect(c.events.filter((e) => e.type === 'tool-result' && e.toolCallId === 'run_shell_command__call_12')).toEqual([
      { type: 'tool-result', toolCallId: 'run_shell_command__call_12', result: '', isError: false },
    ]);
    expect(result.text).toBe('Investigating: run it');
    expect(c.ui.some((e) => e.type === 'permission.requested')).toBe(false);
  });

  it('interrupt() cancels the in-flight prompt and stops the child; the stop is not an agent failure', async () => {
    const c = collect();
    const session = new GeminiAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'slow', cwd, env: { CEZ_MOCK_GEMINI_SLOW: '1' } }, c.onEvent, {
      onUiEvent: c.onUiEvent,
    });
    await waitFor(() => c.ui.some((e) => e.type === 'item.started' && e.item.kind === 'tool'));
    session.interrupt();
    await session.result;
    expect(c.events.map((e) => e.type)).not.toContain('error');
    expect(c.ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' }));
    // The running tool is settled, not left spinning.
    expect(c.ui).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ id: 'run_shell_command__call_1', status: 'failed' }) }));
    expect(session.open).toBe(false);
  });

  it('the run deadline stops a turn as a timeout error', async () => {
    const c = collect();
    await new GeminiAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'slow', cwd, timeoutMs: 1_500, env: { CEZ_MOCK_GEMINI_SLOW: '1' } }, c.onEvent, {
      onUiEvent: c.onUiEvent,
    }).result;
    expect(c.events).toContainEqual({ type: 'error', message: 'Gemini CLI timed out after 0m and was killed' });
    expect(c.ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'timeout' }));
  });
});

describe('GeminiAcpRunner — failures', () => {
  it('exit 41 is an authentication failure in cezar’s words (→ provider-auth-required)', async () => {
    const c = collect();
    await expect(
      new GeminiAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'x', cwd, env: { CEZ_MOCK_GEMINI_EXIT: '41' } }, c.onEvent).result,
    ).rejects.toThrow(GEMINI_AUTH_FAILURE_MESSAGE);
    expect(c.events).toContainEqual({ type: 'error', message: GEMINI_AUTH_FAILURE_MESSAGE });
  });

  it('a Google-login-only account (UNSUPPORTED_CLIENT) fails fast with the API-key hint, never the vendor text', async () => {
    const c = collect();
    await new GeminiAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'x', cwd, env: { CEZ_MOCK_GEMINI_AUTH_FAIL: '1' } }, c.onEvent, {
      onUiEvent: c.onUiEvent,
    }).result;
    expect(c.events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: GEMINI_AUTH_FAILURE_MESSAGE }]);
    expect(JSON.stringify([c.events, c.ui])).not.toContain('Antigravity');
    expect(c.events.at(-1)).toEqual({ type: 'done' });
  });

  it('a child that dies mid-turn fails the turn (turn.completed{error}) and the step', async () => {
    const c = collect();
    await new GeminiAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'x', cwd, env: { CEZ_MOCK_GEMINI_DIE_MID_TURN: '1' } }, c.onEvent, {
      onUiEvent: c.onUiEvent,
    }).result;
    expect(c.events).toContainEqual({ type: 'error', message: 'Gemini CLI exited with code 1' });
    expect(c.ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  });

  it('a missing binary is a clear install hint', async () => {
    await expect(
      new GeminiAcpRunner({ bin: join(tmpdir(), 'cez-gemini-does-not-exist-xyz') }).startSession({ userPrompt: 'x', cwd }).result,
    ).rejects.toThrow('install Gemini CLI');
  });
});

describe('the gemini runner behind the seam (Step 2.5)', () => {
  const saved = { bin: process.env.CEZ_GEMINI_BIN, dry: process.env.CEZ_DRY_RUN };
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.CEZ_GEMINI_BIN;
    else process.env.CEZ_GEMINI_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  it('createRunner maps "gemini" to the ACP runner', () => {
    const runner = createRunner('gemini');
    expect(runner).toBeInstanceOf(GeminiAcpRunner);
    expect(runner.backend).toBe('gemini');
  });

  it('detection reports an absent Gemini CLI as unavailable with the install and API-key hint — never a boot failure', async () => {
    delete process.env.CEZ_DRY_RUN;
    process.env.CEZ_GEMINI_BIN = join(tmpdir(), 'cez-gemini-does-not-exist-xyz');
    const gemini = (await detectEnvironment()).find((check) => check.name === 'gemini');
    expect(gemini).toMatchObject({ available: false });
    expect(gemini!.hint).toContain('npm i -g @google/gemini-cli');
    expect(gemini!.hint).toContain('API key');
  });

  it('detection answers for the mock under CEZ_DRY_RUN=1', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const gemini = (await detectEnvironment()).find((check) => check.name === 'gemini');
    expect(gemini).toEqual({ name: 'gemini', available: true, version: 'mock (CEZ_DRY_RUN=1)' });
  });
});

describe('gemini runner helpers', () => {
  it('builds the ACP command line: model only when chosen, auto mode always', () => {
    expect(buildGeminiArgs({})).toEqual(['--acp', '--approval-mode', 'yolo']);
    expect(buildGeminiArgs({ model: 'gemini-2.5-flash' })).toEqual(['--acp', '--model', 'gemini-2.5-flash', '--approval-mode', 'yolo']);
  });

  it('turns the documented exit codes into cezar-authored lines', () => {
    expect(geminiExitMessage(41, '')).toBe(GEMINI_AUTH_FAILURE_MESSAGE);
    expect(geminiExitMessage(1, "IneligibleTierError reasonCode: 'UNSUPPORTED_CLIENT'")).toBe(GEMINI_AUTH_FAILURE_MESSAGE);
    expect(geminiExitMessage(52, '')).toContain('configuration is invalid');
    expect(geminiExitMessage(55, '')).toContain('not trusted');
    expect(geminiExitMessage(3, 'a\nb\nc\nd')).toBe('Gemini CLI exited with code 3 — b | c | d');
  });
});
