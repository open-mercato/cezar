import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * OPT-IN smoke against the REAL Copilot CLI (#582 Phase 3 Step 4). It spends model requests, so it
 * never runs by default:
 *
 * ```
 * COPILOT_REAL_SMOKE=1 COPILOT_GITHUB_TOKEN=… npm test -- packages/cezar/src/core/copilot-acp-runner.smoke.test.ts
 * ```
 *
 * (a `copilot login` already on the machine works too; `COPILOT_SMOKE_MODEL` overrides the model).
 * Without the opt-in it is **skipped, never failed** — `probeCopilot` and every other Copilot code
 * path already degrade when the CLI is absent.
 *
 * **This test is the live gate for the whole runner.** No Copilot-entitled credential existed on
 * the host that built it, so `__fixtures__/copilot/` is assembled from the CLI's own ACP bridge
 * rather than captured from a live session (see that directory's README). Anyone with a
 * subscription who runs this is checking the one thing the fixtures cannot check for themselves:
 * that the real wire still looks like the bridge said it would. If an assertion here fails, trust
 * this file and fix the fixtures.
 */
const enabled = process.env.COPILOT_REAL_SMOKE === '1'
  && Boolean(process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
const model = process.env.COPILOT_SMOKE_MODEL;

describe.skipIf(!enabled)('copilot runner against the real `copilot --acp` (opt-in)', () => {
  let cwd: string;
  let sessionId: string | undefined;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cez-copilot-smoke-'));
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'README.md'), '# smoke\n');
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('runs one turn: a session id, the answer, usage and a clean end', async () => {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const result = await new CopilotAcpRunner()
      .startSession(
        {
          userPrompt: 'Reply with the single word PONG. Do not use any tools.',
          cwd,
          ...(model ? { model } : {}),
        },
        (e) => events.push(e),
        { autoEndAfterFirstTurn: true, onUiEvent: (e) => ui.push(e) },
      ).result;

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(result.text.toUpperCase()).toContain('PONG');
    expect(result.sessionId).toBeTruthy();
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
    // The claim the fixtures rest on: per-turn usage really is on the prompt result.
    expect(result.tokensUsed).toBeGreaterThan(0);
    sessionId = result.sessionId;
  }, 180_000);

  it('resumes that session with session/load and answers a follow-up in it', async () => {
    expect(sessionId).toBeTruthy();
    const events: AgentEvent[] = [];
    const result = await new CopilotAcpRunner()
      .startSession(
        {
          userPrompt: 'What single word did you just reply with? Answer with that word only.',
          cwd,
          resume: true,
          sessionId,
          ...(model ? { model } : {}),
        },
        (e) => events.push(e),
        { autoEndAfterFirstTurn: true },
      ).result;

    expect(events.some((e) => e.type === 'note' && e.message.includes('could not resume'))).toBe(false);
    expect(result.sessionId).toBe(sessionId);
    expect(result.text.toUpperCase()).toContain('PONG');
  }, 180_000);

  it('reports a tool call as RUNNING before it completes — the `pending` reading the dialect rests on', async () => {
    const ui: UiEvent[] = [];
    await new CopilotAcpRunner()
      .startSession(
        { userPrompt: 'Read README.md with your file tool, then reply with its first line.', cwd, ...(model ? { model } : {}) },
        () => {},
        { autoEndAfterFirstTurn: true, onUiEvent: (e) => ui.push(e) },
      ).result;

    const statuses = ui.flatMap((e) =>
      (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') && e.item.kind === 'tool'
        ? [e.item.status]
        : []);
    expect(statuses).toContain('running');
    expect(statuses).toContain('completed');
  }, 180_000);
});
