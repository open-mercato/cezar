import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';
import { COPILOT_AUTH_FAILURE_MESSAGE } from './copilot-ui-mapper.ts';
import { CopilotAcpRunner, buildCopilotArgs, copilotExitMessage } from './copilot-acp-runner.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * The `copilot` runner (#582, spec 2026-09-19-runner-seam-native-backends Phase 3 Step 3) over the
 * bundled `scripts/mock-copilot-acp.mjs`, whose frames mirror the wire documented in
 * `__fixtures__/copilot/README.md`.
 */
const MOCK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mock-copilot-acp.mjs');

let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cez-copilot-run-')));
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

describe('buildCopilotArgs', () => {
  it('starts the ACP server in the auto permission mode, with updates off', () => {
    expect(buildCopilotArgs({})).toEqual(['--acp', '--allow-all-tools', '--no-auto-update']);
  });

  it('never passes `--stdio` — the CLI has no such flag, and it would abort the spawn', () => {
    expect(buildCopilotArgs({ model: 'auto' })).not.toContain('--stdio');
  });

  it('carries the model and every additional directory', () => {
    expect(buildCopilotArgs({ model: 'claude-sonnet-4', additionalDirectories: ['/srv/shared', '/srv/docs'] }))
      .toEqual(['--acp', '--allow-all-tools', '--no-auto-update', '--model', 'claude-sonnet-4', '--add-dir', '/srv/shared', '--add-dir', '/srv/docs']);
  });
});

describe('copilotExitMessage', () => {
  it('translates an authentication failure into the line the server latches on', () => {
    expect(copilotExitMessage(1, 'error: Authentication required')).toBe(COPILOT_AUTH_FAILURE_MESSAGE);
  });

  it('otherwise reports the code and the tail of stderr, inventing no exit-code meanings', () => {
    expect(copilotExitMessage(7, 'line one\nline two')).toBe('Copilot CLI exited with code 7 — line one | line two');
    expect(copilotExitMessage(null, '')).toBe('Copilot CLI exited with code null');
  });
});

describe('CopilotAcpRunner — one turn over the mock', () => {
  const saved = process.env.CEZ_DRY_RUN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
  });

  it('CEZ_DRY_RUN=1 swaps in the bundled mock and streams both protocols to one done', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const argsFile = join(cwd, 'args.json');
    const c = collect();
    const session = new CopilotAcpRunner().startSession(
      {
        userPrompt: 'fix the login redirect',
        systemPrompt: 'Be terse.',
        cwd,
        model: 'claude-sonnet-4',
        env: { CEZ_MOCK_COPILOT_ARGS_FILE: argsFile },
      },
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
    // The system prompt rides in the first message (ACP has no native channel), so the mock echoes it.
    expect(result.text).toContain('Be terse.');
    expect(result.text).toContain('fix the login redirect');
    expect(result.tokensUsed).toBe(120);
    expect(result.sessionId).toBe('00000000-0000-4000-8000-00000c0p110t');

    const spawned = JSON.parse(readFileSync(argsFile, 'utf8')) as { argv: string[]; cwd: string };
    expect(spawned.argv).toEqual(['--acp', '--allow-all-tools', '--no-auto-update', '--model', 'claude-sonnet-4']);
    // The session's working directory is the spawn cwd, so the agent's tools are rooted in it.
    expect(spawned.cwd).toBe(cwd);

    expect(c.ui.slice(0, 2).map((e) => e.type)).toEqual(['session.started', 'turn.started']);
    expect(c.ui).toContainEqual(expect.objectContaining({ type: 'session.started', backend: 'copilot', cwd }));
    expect(c.ui).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 100, output: 20, total: 120 },
    });
    expect(c.ui.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
  });

  it('reads a started tool as running and its plan off the native plan channel', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const c = collect();
    await new CopilotAcpRunner().startSession({ userPrompt: 'go', cwd }, c.onEvent, {
      autoEndAfterFirstTurn: true,
      onUiEvent: c.onUiEvent,
    }).result;

    const toolStates = c.ui.flatMap((e) =>
      (e.type === 'item.started' || e.type === 'item.completed') && e.item.kind === 'tool' ? [e.item.status] : []);
    expect(toolStates).toEqual(['running', 'completed']);
    expect(c.ui.filter((e) => e.type === 'plan.updated')).toHaveLength(2);
  });

  it('is what the factory builds for `copilot` — never Claude by fallthrough', () => {
    expect(createRunner('copilot')).toBeInstanceOf(CopilotAcpRunner);
    expect(createRunner('copilot').backend).toBe('copilot');
  });
});

describe('CopilotAcpRunner — session lifecycle', () => {
  it('keeps the same ACP session across a follow-up, in order', async () => {
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'first', cwd }, c.onEvent, {
      onUiEvent: c.onUiEvent,
    });
    await waitFor(() => c.events.filter((e) => e.type === 'turn-end').length === 1);
    expect(session.sendMessage([{ type: 'text', text: 'second' }])).toBe(true);
    await waitFor(() => c.events.filter((e) => e.type === 'turn-end').length === 2);
    session.end();
    const result = await session.result;

    expect(c.ui.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(c.ui.filter((e) => e.type === 'turn.started').map((e) => e.type === 'turn.started' && e.turnId))
      .toEqual(['turn_1', 'turn_2']);
    expect(result.text).toContain('turn 2');
    // `usage.updated` is cumulative for the session: 120 then 120 + 220.
    expect(result.tokensUsed).toBe(340);
  });

  it('refuses a message once the session is closed', async () => {
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'hi', cwd }, c.onEvent, {
      autoEndAfterFirstTurn: true,
    });
    await session.result;
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'too late' }])).toBe(false);
  });

  it('resumes an existing session with session/load instead of minting a new one', async () => {
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK }).startSession(
      { userPrompt: 'continue', cwd, resume: true, sessionId: '11111111-2222-4333-8444-555555555555' },
      c.onEvent,
      { autoEndAfterFirstTurn: true, onUiEvent: c.onUiEvent },
    );
    const result = await session.result;

    expect(result.sessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(c.events).toContainEqual({ type: 'session', sessionId: '11111111-2222-4333-8444-555555555555' });
    expect(c.events.some((e) => e.type === 'note' && e.message.includes('could not resume'))).toBe(false);
  });

  it('cancel settles the turn as cancelled and leaves a usable result', async () => {
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'long job', cwd }, c.onEvent, {
      onUiEvent: c.onUiEvent,
    });
    await waitFor(() => c.ui.some((e) => e.type === 'item.started' && e.item.kind === 'tool'));
    session.interrupt();
    await session.result;

    const completed = c.ui.filter((e) => e.type === 'turn.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ stopReason: 'cancelled' });
    // A tool the cancelled turn left running must not stay running forever.
    const toolStatuses = c.ui.flatMap((e) =>
      e.type === 'item.completed' && e.item.kind === 'tool' ? [e.item.status] : []);
    expect(toolStatuses.at(-1)).toBe('failed');
    // cezar asked for the stop, so its own teardown signal is not reported as an agent failure.
    expect(c.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('auto-approves a permission request and notes it, rather than parking the run', async () => {
    // Nothing in the cockpit can answer a permission card yet (spec Q15), so a request that
    // arrives anyway must be answered — a run parked on an unanswerable question is a dead end
    // with no exit, which is the failure mode AGENTS.md § "enumerate the transitions" names.
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK }).startSession(
      { userPrompt: 'go', cwd, env: { CEZ_MOCK_COPILOT_ASK_PERMISSION: '1' } },
      c.onEvent,
      { autoEndAfterFirstTurn: true, onUiEvent: c.onUiEvent },
    );
    const result = await session.result;

    expect(c.events).toContainEqual({
      type: 'note',
      message: 'Copilot asked permission for $ echo dry-run; auto-approved (allow_always) — cezar runs Copilot in auto mode',
    });
    // The choice really reached the agent, and the turn continued to a normal end.
    expect(result.text).toContain('[permission:allow-always]');
    expect(c.ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
  });

  it('never leaves an inbound request cezar does not understand unanswered', async () => {
    // Without an answer the agent waits forever. The transport answers -32601 on its own; this
    // pins that the runner's handler does not swallow the request instead.
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK }).startSession({ userPrompt: 'go', cwd }, c.onEvent, {
      autoEndAfterFirstTurn: true,
    });
    await session.result;
    expect(c.events.filter((e) => e.type === 'note' && e.message.includes('asked permission'))).toEqual([]);
  });

  it('surfaces an unauthenticated agent as a fatal, actionable session error', async () => {
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK }).startSession(
      { userPrompt: 'go', cwd, env: { CEZ_MOCK_COPILOT_UNAUTHENTICATED: '1' } },
      c.onEvent,
      { onUiEvent: c.onUiEvent },
    );
    await session.result;

    expect(c.events).toContainEqual({ type: 'error', message: COPILOT_AUTH_FAILURE_MESSAGE });
    expect(c.ui).toContainEqual({ type: 'session.error', message: COPILOT_AUTH_FAILURE_MESSAGE, fatal: true });
    expect(c.ui.at(-1)).toEqual({ type: 'session.ended', reason: 'error' });
  });

  it('reports a missing binary as an install instruction, never as a silent no-op', async () => {
    const session = new CopilotAcpRunner({ bin: join(cwd, 'definitely-not-copilot') }).startSession(
      { userPrompt: 'go', cwd },
      () => {},
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).rejects.toThrow(/not found on PATH.*@github\/copilot/s);
  });

  it('times out, kills the child, and says so', async () => {
    const c = collect();
    const session = new CopilotAcpRunner({ bin: MOCK, timeoutMs: 1 }).startSession({ userPrompt: 'go', cwd }, c.onEvent, {
      onUiEvent: c.onUiEvent,
    });
    await session.result;
    expect(c.events.some((e) => e.type === 'error' && /timed out/.test(e.message))).toBe(true);
    expect(session.open).toBe(false);
  });
});
