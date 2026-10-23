import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunner } from '../core/agent-runner.ts';
import { CursorAgentRunner } from '../core/cursor-agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { isProviderRefusalError, missingSessionNote, ResumeFallback, resumeFallbackPredicate, vetoesRetryFallback } from './resume-fallback.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_CODEX = join(HERE, '..', 'core', '__fixtures__', 'codex', 'mock-codex-app-server.mjs');
const MOCK_OPENCODE = join(HERE, '..', 'core', '__fixtures__', 'opencode', 'mock-opencode-serve.mjs');
const TASK = 'make the verify check pass';

/** The check fails on its first run and passes on every later one. */
const WORKFLOW: WorkflowDef = {
  name: 'implement-verify',
  source: 'file',
  steps: [
    { id: 'implement', prompt: '{{task}}' },
    { id: 'verify', command: 'test -f .verified || { touch .verified; echo "1 test failed"; exit 1; }', onFail: { retry: 'implement', max: 1 } },
  ],
};

describe('onFail.retry resumes the retried step instead of restarting it', () => {
  let repoRoot: string;
  let turnsFile: string;
  let store: RunStore;
  let manager: RunManager;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string | undefined): void => {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retry-resume-'));
    turnsFile = join(repoRoot, '..', `${basename(repoRoot)}-turns.ndjson`);
    setEnv('CEZ_CODEX_BIN', MOCK_CODEX);
    setEnv('CEZ_AUTONAME', '0');
    setEnv('MOCK_CODEX_TURNS_FILE', turnsFile);
    setEnv('CEZ_MOCK_MISSING_SESSIONS', undefined);
    setEnv('MOCK_CODEX_REJECT_RESUME', undefined);
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_CODEX_TURNS_FILE,MOCK_CODEX_REJECT_RESUME');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, '.gitignore'), '.verified\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(turnsFile, { force: true });
  });

  async function runToEnd(runner: 'codex' | 'opencode' = 'codex'): Promise<string> {
    const record = manager.startRun(WORKFLOW, { task: TASK, runner, worktree: false });
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return record.id;
  }

  const turns = (): string[] =>
    readFileSync(turnsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);

  it('sends only the failure into the session the first attempt left', async () => {
    const id = await runToEnd();
    expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
      ['implement', 'done'],
      ['verify', 'done'],
    ]);

    const [first, retry] = turns();
    expect(turns()).toHaveLength(2);
    expect(first).toContain(TASK);
    expect(retry).toContain('A verification command failed after the previous attempt');
    expect(retry).toContain('1 test failed');
    // Neither the task nor the system prompt is paid for a second time.
    expect(retry).not.toContain(TASK);
    expect(retry).not.toContain('## Handoff (cezar)');
    expect(store.getRun(id)?.steps.find((s) => s.id === 'implement')?.sessionId).toBe('th_mock_1');
    expect(store.readEvents(id).some((e) => e.type === 'note' && String(e.message).includes("previous session — sending only the failure"))).toBe(true);
  }, 30_000);

  it('falls back to a fresh session carrying the whole task when codex no longer has the thread', async () => {
    setEnv('MOCK_CODEX_REJECT_RESUME', '1');
    const id = await runToEnd();
    expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
      ['implement', 'done'],
      ['verify', 'done'],
    ]);

    // The rejected resume never starts a turn: the first attempt, then the fresh fallback.
    const all = turns();
    expect(all).toHaveLength(2);
    expect(all[1]).toContain(TASK);
    expect(all[1]).toContain('## Handoff (cezar)');
    expect(all[1]).toContain('1 test failed');
    expect(store.readEvents(id).some((e) => e.type === 'note' && e.message === missingSessionNote('codex'))).toBe(true);
    expect(store.readEvents(id).some((e) => e.type === 'error' && e.stepId === 'implement')).toBe(false);
  }, 30_000);

  it('keeps the run token totals when the codex resume falls back', async () => {
    setEnv('MOCK_CODEX_REJECT_RESUME', '1');
    const id = await runToEnd();
    const record = store.getRun(id);
    const step = record?.steps.find((s) => s.id === 'implement');
    expect(step?.usageInvocationsStarted).toBe(step?.usageInvocationsObserved);
    expect(record?.inputTokens).toBe(2400);
    expect(record?.outputTokens).toBe(600);
  }, 30_000);

  it('falls back to a fresh session when opencode answers the resume with a 404', async () => {
    const promptsFile = join(repoRoot, '..', `${basename(repoRoot)}-opencode-prompts.ndjson`);
    setEnv('CEZ_OPENCODE_BIN', MOCK_OPENCODE);
    setEnv('MOCK_OPENCODE_PROMPTS_FILE', promptsFile);
    setEnv('MOCK_OPENCODE_SESSIONS_GONE', '1');
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_OPENCODE_PROMPTS_FILE,MOCK_OPENCODE_SESSIONS_GONE');
    try {
      const id = await runToEnd('opencode');
      expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
        ['implement', 'done'],
        ['verify', 'done'],
      ]);
      const prompts = readFileSync(promptsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(TASK);
      expect(prompts[1]).toContain('1 test failed');
      expect(store.readEvents(id).some((e) => e.type === 'note' && e.message === missingSessionNote('opencode'))).toBe(true);
    } finally {
      rmSync(promptsFile, { force: true });
    }
  }, 30_000);

  it('counts only the new usage of a resumed codex thread that restores its total', async () => {
    // The first attempt's thread reached 1,500 tokens; the reopened thread reports that total
    // before its turn and 3,000 after it. The step used 1,500 + 1,500, not 1,500 + 3,000.
    setEnv('MOCK_CODEX_RESTORED_TOTAL', '1500');
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_CODEX_TURNS_FILE,MOCK_CODEX_RESTORED_TOTAL');
    const id = await runToEnd();
    expect(turns()).toHaveLength(2);
    expect(store.getRun(id)?.steps.find((s) => s.id === 'implement')?.tokensUsed).toBe(3000);
  }, 30_000);

  it('counts a pre-turn total that does not match the recorded one as new usage', async () => {
    // 700 is not the 1,500 the thread had reached, so it is real usage, never subtracted.
    setEnv('MOCK_CODEX_RESTORED_TOTAL', '700');
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_CODEX_TURNS_FILE,MOCK_CODEX_RESTORED_TOTAL');
    const id = await runToEnd();
    expect(store.getRun(id)?.steps.find((s) => s.id === 'implement')?.tokensUsed).toBe(1500 + 2200);
  }, 30_000);

  it('does not recount a codex thread a Continue reopens', async () => {
    const record = manager.startRun({ name: 'one', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }, { id: 'verify', command: 'true' }] }, { task: TASK, runner: 'codex', worktree: false });
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    let deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(store.getRun(record.id)?.steps.find((s) => s.id === 'work')?.sessionTokensTotal).toBe(1500);

    setEnv('MOCK_CODEX_RESTORED_TOTAL', '1500');
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_CODEX_TURNS_FILE,MOCK_CODEX_RESTORED_TOTAL');
    expect(manager.continueRun(record.id, { text: 'keep going', runner: 'codex' })).toEqual({ ok: true });
    deadline = Date.now() + 25_000;
    while (!['waiting', 'done', 'failed'].includes(store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1')?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('continue did not settle');
      await new Promise((r) => setTimeout(r, 100));
    }
    const step = store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1');
    expect(step?.sessionId).toBe('th_mock_1');
    expect(step?.tokensUsed).toBe(1500);
  }, 60_000);

  it('does not fall back when codex refuses the resumed retry', async () => {
    setEnv('MOCK_CODEX_REJECT_RESUME', 'limit');
    const id = await runToEnd();
    expect(store.getRun(id)?.status).toBe('failed');
    expect(turns()).toHaveLength(1);
    expect(store.readEvents(id).some((e) => e.type === 'note' && e.message === missingSessionNote('codex'))).toBe(false);
  }, 30_000);

  it('continues an opencode task in a fresh session with its saved context when the session is gone', async () => {
    const promptsFile = join(repoRoot, '..', `${basename(repoRoot)}-opencode-prompts.ndjson`);
    setEnv('CEZ_OPENCODE_BIN', MOCK_OPENCODE);
    setEnv('MOCK_OPENCODE_PROMPTS_FILE', promptsFile);
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_OPENCODE_PROMPTS_FILE,MOCK_OPENCODE_SESSIONS_GONE');
    try {
      const record = manager.startRun({ name: 'one', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }, { id: 'verify', command: 'true' }] }, { task: TASK, runner: 'opencode', worktree: false });
      const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
      let deadline = Date.now() + 25_000;
      while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
        if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(store.getRun(record.id)?.steps.find((s) => s.id === 'work')?.sessionId).toBe('ses_mock_1');

      setEnv('MOCK_OPENCODE_SESSIONS_GONE', '1');
      expect(manager.continueRun(record.id, { text: 'keep going', runner: 'opencode' })).toEqual({ ok: true });
      deadline = Date.now() + 25_000;
      while (!['waiting', 'done', 'failed'].includes(store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1')?.status ?? '')) {
        if (Date.now() > deadline) throw new Error('continue did not settle');
        await new Promise((r) => setTimeout(r, 100));
      }
      const step = store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1');
      expect(step?.status).not.toBe('failed');
      const prompts = readFileSync(promptsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);
      const fresh = prompts.at(-1)!;
      expect(fresh).toContain('You are continuing an existing Cezar task');
      expect(fresh).toContain(TASK);
      expect(fresh).toContain('## New user instruction\nkeep going');
      expect(store.readEvents(record.id).some((e) => e.type === 'note' && e.message === missingSessionNote('opencode'))).toBe(true);
    } finally {
      rmSync(promptsFile, { force: true });
    }
  }, 60_000);

  it('does not resume a strict backend under a different account', async () => {
    const seam = manager as unknown as {
      agentEnvForStep: (runId: string, backend: string, options?: { recordedProfileId?: string }) => Promise<{ env: Record<string, string>; profileId: string }>;
    };
    const real = seam.agentEnvForStep.bind(manager);
    let calls = 0;
    const spy = vi.spyOn(seam, 'agentEnvForStep').mockImplementation(async (runId, backend, options) => {
      const resolved = await real(runId, backend, options);
      calls += 1;
      return { ...resolved, profileId: calls === 1 ? 'work' : 'personal' };
    });
    try {
      const id = await runToEnd();
      const all = turns();
      expect(all).toHaveLength(2);
      // The previous attempt recorded `work`; the retry resolved to another account, so it must
      // run the whole task in a fresh session rather than reopen the wrong account's session.
      expect(all[1]).toContain(TASK);
      expect(all[1]).toContain('## Handoff (cezar)');
      expect(store.readEvents(id).some((e) => e.type === 'note' && String(e.message).includes('sending only the failure'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  describe('on claude', () => {
    const claudeWorkflow = (marker: string): WorkflowDef => ({
      ...WORKFLOW,
      steps: [
        WORKFLOW.steps[0]!,
        { id: 'verify', command: `test -f .verified || { touch .verified; echo "1 test failed ${marker}"; exit 1; }`, onFail: { retry: 'implement', max: 1 } },
      ],
    });

    interface ClaudeRun {
      id: string;
      argv: string[][];
      prompts: string[];
    }

    async function runClaude(marker: string, options: { onFirstSession?: (id: string) => void } = {}): Promise<ClaudeRun> {
      const argsFile = join(repoRoot, '..', `${basename(repoRoot)}-args.ndjson`);
      const stdinFile = join(repoRoot, '..', `${basename(repoRoot)}-stdin.ndjson`);
      setEnv('CEZ_DRY_RUN', '1');
      setEnv('CEZ_MOCK_ARGS_FILE', argsFile);
      setEnv('CEZ_MOCK_STDIN_FILE', stdinFile);
      try {
        const record = manager.startRun(claudeWorkflow(marker), { task: TASK, runner: 'claude', worktree: false });
        const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
        const deadline = Date.now() + 25_000;
        if (options.onFirstSession) {
          while (!store.getRun(record.id)?.steps.find((s) => s.id === 'implement')?.sessionId) {
            if (Date.now() > deadline) throw new Error('the first attempt never started');
            await new Promise((r) => setTimeout(r, 5));
          }
          options.onFirstSession(record.id);
        }
        while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
          if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
        return {
          id: record.id,
          argv: lines(argsFile) as string[][],
          prompts: (lines(stdinFile) as { userText: string }[]).map((entry) => entry.userText),
        };
      } finally {
        rmSync(argsFile, { force: true });
        rmSync(stdinFile, { force: true });
      }
    }

    const notesOf = (id: string): string[] =>
      store.readEvents(id).filter((e) => e.type === 'note').map((e) => String(e.message));

    it('resumes the session the first attempt pinned and sends it only the failure', async () => {
      const { id, argv, prompts } = await runClaude('mock:plain');
      expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
        ['implement', 'done'],
        ['verify', 'done'],
      ]);
      expect(argv).toHaveLength(2);
      const [first, resumed] = argv;
      expect(resumed).toContain('--resume');
      expect(resumed![resumed!.indexOf('--resume') + 1]).toBe(first![first!.indexOf('--session-id') + 1]);
      expect(prompts[1]).toContain('1 test failed');
      expect(prompts[1]).not.toContain(TASK);
      expect(notesOf(id).some((m) => m.includes('sending only the failure'))).toBe(true);
    }, 30_000);

    it.each([
      ['the CLI reports it on stderr', () => setEnv('CEZ_MOCK_MISSING_SESSIONS', '*'), 'mock:plain'],
      ['the CLI reports it only in the result frame `errors`', () => undefined, 'mock:session-gone'],
    ])('a pruned conversation on retry goes through the missing-session fallback when %s', async (_label, arm, marker) => {
      arm();
      const { id, argv, prompts } = await runClaude(marker);
      expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
        ['implement', 'done'],
        ['verify', 'done'],
      ]);
      expect(argv).toHaveLength(3);
      const [first, resumed, fresh] = argv;
      expect(first).toContain('--session-id');
      expect(resumed).toContain('--resume');
      expect(resumed![resumed!.indexOf('--resume') + 1]).toBe(first![first!.indexOf('--session-id') + 1]);
      expect(fresh).toContain('--session-id');
      expect(fresh).not.toContain('--resume');
      // The fresh session runs the step's whole prompt: the task and the failure.
      const freshPrompt = prompts.at(-1)!;
      expect(freshPrompt).toContain(TASK);
      expect(freshPrompt).toContain('1 test failed');
      expect(notesOf(id)).toContain(missingSessionNote('claude'));
      const implement = store.getRun(id)?.steps.find((s) => s.id === 'implement');
      expect(implement?.sessionId).toBe(fresh![fresh!.indexOf('--session-id') + 1]);
      // The dead resume's bookkeeping was dropped, so the run's token totals stay consistent.
      expect(implement?.usageInvocationsStarted).toBe(implement?.usageInvocationsObserved);
      expect(store.getRun(id)?.inputTokens).toBeGreaterThan(0);
    }, 30_000);

    it('carries the reports the dead resume had flushed into the fresh session', async () => {
      setEnv('CEZ_MOCK_MISSING_SESSIONS', '*');
      const pending = {
        fromRunId: 'child_run_1',
        title: 'Auth check',
        report: { status: 'done' as const, result: 'auth refactor finished', evidence: [], side_effects: [], errors: [], suggestions: [] },
        at: '2026-09-30T00:00:00.000Z',
      };
      // The first attempt flushes pending reports before it is given a session id; seeding after
      // that leaves one for the retry to flush, which the fresh fallback must then carry.
      const { prompts } = await runClaude('mock:plain', {
        onFirstSession: (id) => store.updateRun(id, { dispatch: { rootRunId: id, pendingReports: [pending] } }),
      });
      const freshPrompt = prompts.at(-1)!;
      expect(freshPrompt).toContain('auth refactor finished');
      expect(freshPrompt).toContain('Reports from your dispatched tasks');
    }, 30_000);

    it('does not restart when the resumed session fails with a usage limit', async () => {
      const { id, argv } = await runClaude('mock:resume-limit');
      // A usage limit is not a missing conversation: the retry must fail on the limit rather than
      // pay for a whole fresh prompt that would hit the same limit.
      expect(store.getRun(id)?.status).toBe('failed');
      expect(argv).toHaveLength(2);
      expect(argv[1]).toContain('--resume');
      expect(notesOf(id)).not.toContain(missingSessionNote('claude'));
    }, 30_000);

    it('does not restart a session that reopened and then failed mid-turn', async () => {
      const { id, argv } = await runClaude('mock:resume-mid-fail');
      expect(store.getRun(id)?.status).toBe('failed');
      expect(argv).toHaveLength(2);
      expect(argv[1]).toContain('--resume');
      expect(notesOf(id)).not.toContain(missingSessionNote('claude'));
    }, 30_000);

    it('still falls back when a resume error has an unrecognized wording', async () => {
      const { id, argv } = await runClaude('mock:resume-mystery');
      // A retry falls back on anything that is not a refusal, not on an allowlist of wordings.
      expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
        ['implement', 'done'],
        ['verify', 'done'],
      ]);
      expect(argv).toHaveLength(3);
      expect(argv[1]).toContain('--resume');
      expect(argv[2]).not.toContain('--resume');
      expect(notesOf(id)).toContain(missingSessionNote('claude'));
    }, 30_000);

    it('sends a graph node its re-rendered instructions with the failure when they changed', async () => {
      const graph: WorkflowGraph = {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'implement', type: 'agent', prompt: 'pass {{nodes.retry.iteration}}: {{task}}' },
          { id: 'tests', type: 'check', command: 'test -f .verified || { touch .verified; echo "1 test failed"; exit 1; }' },
          { id: 'retry', type: 'loop', max: 2 },
          { id: 'ok', type: 'end', status: 'success' },
          { id: 'gave-up', type: 'end', status: 'failed' },
        ],
        edges: [
          { from: 'start', to: 'implement' },
          { from: 'implement', to: 'tests' },
          { from: 'tests.pass', to: 'ok' },
          { from: 'tests.fail', to: 'retry' },
          { from: 'retry.repeat', to: 'implement' },
          { from: 'retry.exhausted', to: 'gave-up' },
        ],
      };
      const stdinFile = join(repoRoot, '..', `${basename(repoRoot)}-graph-stdin.ndjson`);
      setEnv('CEZ_DRY_RUN', '1');
      setEnv('CEZ_MOCK_STDIN_FILE', stdinFile);
      try {
        const record = manager.startRun({ name: 'graph', source: 'file', steps: graphToSteps(graph), graph }, { task: TASK, runner: 'claude', worktree: false });
        const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
        const deadline = Date.now() + 25_000;
        while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
          if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const prompts = readFileSync(stdinFile, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { userText: string }).userText);
        expect(prompts).toHaveLength(2);
        expect(notesOf(record.id).some((m) => m.includes('sending only the failure'))).toBe(true);
        expect(prompts[1]).toContain('Your instructions for this step changed since the previous attempt');
        expect(prompts[1]).toContain(`pass 1: ${TASK}`);
        expect(prompts[1]).toContain('1 test failed');
      } finally {
        rmSync(stdinFile, { force: true });
      }
    }, 30_000);
  });
  describe('on cursor', () => {
    // Cursor print mode has no verified resume, so a retry must stay a fresh session that is
    // sent the whole task again — never a failure-only prompt into a chat that may be blank.
    it('retries in a fresh session carrying the whole task', async () => {
      const cursorRunner: AgentRunner = new CursorAgentRunner();
      expect(cursorRunner.strictResume).toBeUndefined();
      const argsFile = join(repoRoot, '..', `${basename(repoRoot)}-cursor-args.ndjson`);
      setEnv('CEZ_DRY_RUN', '1');
      setEnv('CEZ_MOCK_ARGS_FILE', argsFile);
      try {
        const record = manager.startRun(WORKFLOW, { task: TASK, runner: 'cursor', worktree: false });
        const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
        const deadline = Date.now() + 25_000;
        while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
          if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(store.getRun(record.id)?.steps.map((s) => [s.id, s.status])).toEqual([
          ['implement', 'done'],
          ['verify', 'done'],
        ]);
        const argv = readFileSync(argsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(argv).toHaveLength(2);
        const retry = argv[1]!;
        expect(retry).not.toContain('--resume');
        expect(retry.at(-1)).toContain(TASK);
        expect(retry.at(-1)).toContain('## Handoff (cezar)');
        expect(retry.at(-1)).toContain('1 test failed');
        const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String(e.message));
        expect(notes.some((m) => m.includes('sending only the failure'))).toBe(false);
      } finally {
        rmSync(argsFile, { force: true });
      }
    }, 30_000);
  });
});

describe('isProviderRefusalError', () => {
  it.each([
    ['Claude AI usage limit reached|1767225600'],
    ["You've hit your usage limit. Upgrade to Pro to continue."],
    ['insufficient_quota: You exceeded your current quota'],
    ['You exceeded your current quota, please check your plan'],
    ['Credit balance is too low'],
    ['quota exceeded for this billing period'],
    ['usage_limit_reached'],
    ['usageLimitExceeded'],
    ['429 Too Many Requests'],
    ['Too Many Requests'],
    ['HTTP 429'],
    ['request failed with status 429'],
    ['529 Overloaded'],
    ['you are being rate limited'],
    ['Service overloaded, please retry'],
    ['402 Payment Required'],
    ['Payment Required'],
    ['billing hard limit has been reached'],
    ['HTTP 403'],
    ['403 Forbidden'],
    ['Forbidden'],
    ['permission_error: this key cannot use the model'],
    ['Not logged in · Please run /login'],
    ['Invalid API key · Please run /login'],
  ])('treats a provider refusal as one: %s', (message) => {
    expect(isProviderRefusalError(message)).toBe(true);
  });

  it.each([
    'No conversation found with session ID: abc',
    'no rollout found for thread id th_1',
    'opencode no longer has session ses_x (GET /session/ses_x → 404)',
    'resume failed: ERR_RESUME_PROTOCOL_v7',
    'API Error: 500 Internal Server Error',
    'ran 529 tests, 429 passed',
  ])('does not mistake a session failure for a refusal: %s', (message) => {
    expect(isProviderRefusalError(message)).toBe(false);
  });
});

describe('a retry fallback is vetoed by a refusal or a timeout', () => {
  const error = (message: string): AgentEvent => ({ type: 'error', message });
  const retryGuard = () => new ResumeFallback(true, () => undefined, () => undefined, resumeFallbackPredicate('codex', 'retry'), vetoesRetryFallback);

  it('falls back on an unrecognised error alone', () => {
    const guard = retryGuard();
    guard.hold(error('resume failed: ERR_RESUME_PROTOCOL_v7'));
    expect(guard.takeFallback()).toEqual([]);
  });

  it('a refusal held first is not undone by a later generic error', () => {
    const guard = retryGuard();
    guard.hold(error('HTTP 429 Too Many Requests'));
    guard.hold(error('codex app-server exited with code 1'));
    expect(guard.takeFallback()).toBeUndefined();
  });

  it.each([
    'claude CLI timed out after 30m and was killed',
    'codex app-server timed out after 30m and was killed',
    'opencode timed out after 30m and was killed',
  ])('a timeout is not a reason to start over: %s', (message) => {
    const guard = retryGuard();
    guard.hold(error(message));
    guard.hold(error('session closed'));
    expect(guard.takeFallback()).toBeUndefined();
  });
});
