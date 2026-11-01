import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_MODELS_LOCKED_ENV } from '../core/agent-model-policy.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import { resolveContinuationModel } from './run-continuation-model.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** #1488 — a continued turn runs on the model of the step that owns its session. */
describe('resolveContinuationModel', () => {
  const step = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, ...extra });
  const record = (extra: Record<string, unknown>): RunRecord => ({
    model: 'opus',
    steps: [step('work', { sessionId: 's1' })],
    workflowDef: { name: 'w', source: 'built-in', steps: [{ id: 'work', model: 'haiku', prompt: 'x' }] },
    ...extra,
  }) as unknown as RunRecord;

  it('takes the owning step\'s model: from the workflow definition (records without per-step model)', () => {
    expect(resolveContinuationModel(record({}), 'continue-1', 's1', 'claude')).toBe('haiku');
  });

  it('falls back to the run model with no definition, no pin, or no session', () => {
    expect(resolveContinuationModel(record({ workflowDef: undefined }), 'continue-1', 's1', 'claude')).toBe('opus');
    expect(resolveContinuationModel(record({
      workflowDef: { name: 'w', source: 'built-in', steps: [{ id: 'work', prompt: 'x' }] },
    }), 'continue-1', 's1', 'claude')).toBe('opus');
    expect(resolveContinuationModel(record({}), 'continue-1', undefined, 'claude')).toBe('opus');
    expect(resolveContinuationModel(undefined, 'continue-1', 's1', 'claude')).toBeUndefined();
  });

  it('does not lend a pin to a step on a different runner', () => {
    const r = record({
      workflowDef: { name: 'w', source: 'built-in', steps: [{ id: 'work', runner: 'codex', model: 'gpt-5.1', prompt: 'x' }] },
    });
    expect(resolveContinuationModel(r, 'continue-1', 's1', 'claude')).toBe('opus');
    expect(resolveContinuationModel(r, 'continue-1', 's1', 'codex')).toBe('gpt-5.1');
  });

  it('lets a pick stamped on the turn win, \'\' meaning auto', () => {
    const r = record({ steps: [step('work', { sessionId: 's1' }), step('continue-1', { model: 'sonnet' })] });
    expect(resolveContinuationModel(r, 'continue-1', 's1', 'claude')).toBe('sonnet');
    const auto = record({ steps: [step('work', { sessionId: 's1' }), step('continue-1', { model: '' })] });
    expect(resolveContinuationModel(auto, 'continue-1', 's1', 'claude')).toBeUndefined();
  });

  it('keeps a previous continuation\'s model on the next one of the same session', () => {
    const r = record({
      steps: [step('work', { sessionId: 's1' }), step('continue-1', { sessionId: 's1', model: 'sonnet' }), step('continue-2')],
    });
    expect(resolveContinuationModel(r, 'continue-2', 's1', 'claude')).toBe('sonnet');
  });
});

describe('continuation model wiring (dry run)', () => {
  let repoRoot: string;
  let argsFile: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-step-model-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_ARGS_FILE', 'CEZ_FOLLOWUPS', AGENT_MODELS_LOCKED_ENV]) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env[AGENT_MODELS_LOCKED_ENV];
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ maxParallel: 1 }), 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const workflow: WorkflowDef = {
    name: 'step-model-continue',
    source: 'built-in',
    steps: [
      { id: 'work', model: 'haiku', prompt: '{{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };
  const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

  async function waitFor(done: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const invocations = (): string[][] =>
    readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const modelOf = (argv: string[] | undefined): string | undefined => {
    const idx = argv?.indexOf('--model') ?? -1;
    return idx < 0 ? undefined : argv![idx + 1];
  };

  async function finishedRun(): Promise<string> {
    writeFileSync(argsFile, '', 'utf8');
    const record = manager.startRun(workflow, { task: 'do the thing', model: 'opus' });
    await waitFor(() => TERMINAL.has(store.getRun(record.id)?.status ?? ''), 'run end');
    expect(modelOf(invocations()[0])).toBe('haiku');
    return record.id;
  }

  it('Continue keeps the step\'s model, not the run\'s', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => invocations().length >= 2, 'continuation');
    expect(modelOf(invocations()[1])).toBe('haiku');
    expect(store.getRun(id)?.steps.find((s) => s.id === 'continue-1')?.modelIdentity).toBe('anthropic/haiku');
  }, 60_000);

  it('an explicit model in the composer outranks the step\'s model', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: 'keep going', model: 'sonnet' })).toEqual({ ok: true });
    await waitFor(() => invocations().length >= 2, 'continuation');
    expect(modelOf(invocations()[1])).toBe('sonnet');
  }, 60_000);

  it('a locked model policy ignores the step\'s model on Continue', async () => {
    const id = await finishedRun();
    process.env[AGENT_MODELS_LOCKED_ENV] = '1';
    try {
      expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
      await waitFor(() => invocations().length >= 2, 'continuation');
      expect(modelOf(invocations()[1])).toBeUndefined();
    } finally {
      delete process.env[AGENT_MODELS_LOCKED_ENV];
    }
  }, 60_000);
});
