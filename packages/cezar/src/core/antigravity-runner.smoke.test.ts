import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * OPT-IN smoke against the REAL Antigravity CLI. It spends model requests, so it never runs by
 * default:
 *
 * ```
 * AGY_REAL_SMOKE=1 npm test -- packages/cezar/src/core/antigravity-runner.smoke.test.ts
 * ```
 *
 * It needs an `agy` already signed in with a Google account (`CEZ_AGY_BIN` points at another
 * binary; `AGY_SMOKE_MODEL` overrides the model). Without the opt-in it is **skipped, never
 * failed**. `__fixtures__/antigravity/` are redacted live captures; if an assertion here fails,
 * the wire has moved — trust this file and re-capture the fixtures.
 */
const enabled = process.env.AGY_REAL_SMOKE === '1';
const model = process.env.AGY_SMOKE_MODEL;

describe.skipIf(!enabled)('antigravity runner against the real `agy` (opt-in)', () => {
  let cwd: string;
  let sessionId: string | undefined;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cez-agy-smoke-'));
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'README.md'), '# smoke\n');
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('runs one turn: a session id, the answer, usage and a clean end', async () => {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const result = await new AntigravityRunner()
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
    expect(result.tokensUsed).toBeGreaterThan(0);
    sessionId = result.sessionId;
  }, 180_000);

  it('resumes that conversation with --conversation and answers a follow-up in it', async () => {
    expect(sessionId).toBeTruthy();
    const result = await new AntigravityRunner()
      .startSession(
        {
          userPrompt: 'What single word did you just reply with? Answer with that word only.',
          cwd,
          resume: true,
          sessionId,
          ...(model ? { model } : {}),
        },
        () => {},
        { autoEndAfterFirstTurn: true },
      ).result;

    expect(result.sessionId).toBe(sessionId);
    expect(result.text.toUpperCase()).toContain('PONG');
  }, 180_000);

  it('reports a tool call as running, then completed', async () => {
    const ui: UiEvent[] = [];
    await new AntigravityRunner()
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
