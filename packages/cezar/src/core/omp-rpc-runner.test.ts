import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.js';
import { detectEnvironment } from './backend-detect.js';
import { createRunner } from './runner-factory.js';
import { buildOmpArgs, OmpRpcRunner } from './omp-rpc-runner.js';

/**
 * The `omp` runner: a new AgentBackend slotted into the runner seam as ONE
 * class, pi's successor on the same stdio RPC family. These lock the same
 * seam-level guarantees pi's test does — the factory hands back an omp runner,
 * detection degrades gracefully when the CLI is absent, and the RPC protocol
 * emits the normalized streams every backend shares.
 */

describe('createRunner returns the omp runner', () => {
  it('maps the "omp" id to an OmpRpcRunner with backend "omp"', () => {
    const runner = createRunner('omp');
    expect(runner).toBeInstanceOf(OmpRpcRunner);
    expect(runner.backend).toBe('omp');
  });
});

describe('backend-detect handles an absent omp CLI', () => {
  const saved = { bin: process.env.CEZ_OMP_BIN, dry: process.env.CEZ_DRY_RUN };

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN; // real probe, not the mock short-circuit
    process.env.CEZ_OMP_BIN = join(tmpdir(), 'cez-omp-does-not-exist-xyz');
  });
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.CEZ_OMP_BIN;
    else process.env.CEZ_OMP_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  it('reports omp as unavailable with a hint, and never rejects (no boot failure)', async () => {
    const checks = await detectEnvironment();
    const omp = checks.find((c) => c.name === 'omp');
    expect(omp).toBeDefined();
    expect(omp!.available).toBe(false);
    expect(omp!.hint).toContain('omp');
  });
});

describe('a dry-run omp session emits normalized AgentEvents', () => {
  const saved = process.env.CEZ_DRY_RUN;
  let cwd: string;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1'; // swap in the shared mock CLI
    cwd = mkdtempSync(join(tmpdir(), 'cez-omp-run-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('streams text, a tool call/result and a terminal done over the mock', async () => {
    const runner = new OmpRpcRunner();
    expect(runner.backend).toBe('omp');

    const events: AgentEvent[] = [];
    const result = await runner.run(
      { userPrompt: 'investigate the login redirect bug', cwd, timeoutMs: 20_000 },
      (event) => events.push(event),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    // Every backend's stream is terminated by exactly one `done`.
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('ends the run through the settle grace when prompt_result is unsettled and no session_settled follows', async () => {
    // A real-omp regression: `sessionSettled:false` with a silently missed
    // `session_settled` frame parked the run until the deadline killed it. The
    // bounded grace must tear the session down on the normal path instead.
    process.env.CEZ_MOCK_OMP_UNSETTLED = '1';
    const runner = new OmpRpcRunner({ settleGraceMs: 500 });
    const events: AgentEvent[] = [];
    const result = await runner.run(
      { userPrompt: 'investigate', cwd, timeoutMs: 20_000 },
      (event) => events.push(event),
    );
    const types = events.map((e) => e.type);
    expect(types).not.toContain('error');
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('hard-stops a child that ignores SIGTERM (SIGTERM→SIGKILL watchdog)', async () => {
    // The timeout watchdog alone must not resolve a wedged teardown: a CLI that
    // swallows SIGTERM needs the SIGKILL escalation (AGENT_PROTOCOL.md §1).
    process.env.CEZ_MOCK_OMP_IGNORE_TERM = '1';
    const runner = new OmpRpcRunner({ settleGraceMs: 200, killGraceMs: 300 });
    const events: AgentEvent[] = [];
    const result = await runner.run(
      { userPrompt: 'investigate', cwd, timeoutMs: 20_000 },
      (event) => events.push(event),
    );
    const types = events.map((e) => e.type);
    // The run itself completed normally; only the (self-caused) signal kill
    // settled it — never an error, never a timeout.
    expect(types).not.toContain('error');
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('omp RPC argv', () => {
  it('uses rpc mode headless, resume by session id, the append-system-prompt channel and the raw model', () => {
    expect(
      buildOmpArgs({
        cwd: '/repo',
        userPrompt: 'task',
        sessionId: 'session-1',
        resume: true,
        model: 'openai/gpt-5.1',
        systemPrompt: 'Keep changes focused.',
      }),
    ).toEqual([
      '--mode',
      'rpc',
      '--no-ui',
      '--resume',
      'session-1',
      '--append-system-prompt',
      'Keep changes focused.',
      '--model',
      'openai/gpt-5.1',
    ]);
  });

  it('spawns a fresh process without resume flags when there is no session to resume', () => {
    expect(buildOmpArgs({ cwd: '/repo', userPrompt: 'task' })).toEqual(['--mode', 'rpc', '--no-ui']);
  });
});