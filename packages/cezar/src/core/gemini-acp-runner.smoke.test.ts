import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { GeminiAcpRunner } from './gemini-acp-runner.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * OPT-IN smoke against the REAL Gemini CLI (#581 Phase 2 Step 7). It spends two model requests, so
 * it never runs by default: set `GEMINI_REAL_SMOKE=1` and a `GEMINI_API_KEY` (a free key serves the
 * Flash models; `GEMINI_SMOKE_MODEL` overrides the default Flash id), then
 * `GEMINI_REAL_SMOKE=1 GEMINI_API_KEY=… npm test -- packages/cezar/src/core/gemini-acp-runner.smoke.test.ts`.
 * Without both it is skipped, never failed.
 */
const enabled = process.env.GEMINI_REAL_SMOKE === '1' && Boolean(process.env.GEMINI_API_KEY);
const model = process.env.GEMINI_SMOKE_MODEL ?? 'gemini-3-flash-preview';

describe.skipIf(!enabled)('gemini runner against the real `gemini --acp` (opt-in)', () => {
  let cwd: string;
  let sessionId: string | undefined;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cez-gemini-smoke-'));
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'README.md'), '# smoke\n');
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('runs one turn: a session id, the answer, usage and a clean end', async () => {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const result = await new GeminiAcpRunner()
      .startSession({ userPrompt: 'Reply with the single word PONG. Do not use any tools.', cwd, model }, (e) => events.push(e), {
        autoEndAfterFirstTurn: true,
        onUiEvent: (e) => ui.push(e),
      })
      .result;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(result.text.toUpperCase()).toContain('PONG');
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
    sessionId = result.sessionId;
  }, 180_000);

  it('Continue resumes the same session with session/load and does not replay the history', async () => {
    expect(sessionId).toBeDefined();
    const events: AgentEvent[] = [];
    const result = await new GeminiAcpRunner()
      .startSession(
        { userPrompt: 'What single word did you reply with last time? Reply with just that word.', cwd, model, sessionId, resume: true },
        (e) => events.push(e),
        { autoEndAfterFirstTurn: true },
      )
      .result;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(result.sessionId).toBe(sessionId);
    // The answer remembers the first turn; the first turn's own text is not re-emitted.
    expect(result.text.toUpperCase()).toContain('PONG');
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
  }, 180_000);
});
