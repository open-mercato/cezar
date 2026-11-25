import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { READ_ONLY_PROMPT } from './landing.ts';
import { GLOBAL_INSTRUCTIONS_HEADING, PROJECT_INSTRUCTIONS_HEADING, resolveExtraSystemPrompt, RunManager, withCurrentGlobalInstructions } from './run.ts';
import type { WorkflowDef } from './types.ts';

const sessions = vi.hoisted(() => [] as Array<{ spec: AgentRunSpec; emit: (event: AgentEvent) => void; settle: () => void }>);

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: RunnerId) => ({
    backend,
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void) {
      let open = true;
      let resolve!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>((done) => { resolve = done; });
      const settle = () => {
        open = false;
        resolve({ text: '', tokensUsed: 0, toolCalls: [] });
      };
      sessions.push({ spec, emit, settle });
      return { get open() { return open; }, result, sendMessage: vi.fn(() => true), end: settle, interrupt: vi.fn(), hardStop: vi.fn(settle) };
    },
  }),
}));

const OLD = 'Run the whole suite before every commit.';
const NEW = 'Never run the full test suite; run focused tests only.';
const wait = { timeout: 12_000, interval: 20 };
const workflow: WorkflowDef = {
  name: 'custom', source: 'file',
  steps: [
    { id: 'work', name: 'Work', prompt: '{{task}}', runner: 'claude' },
    { id: 'review', name: 'Review', prompt: 'Review {{task}}', runner: 'claude' },
  ],
};

describe('withCurrentGlobalInstructions', () => {
  const project = 'Keep the API stable.';
  it('keeps a prompt that already carries the current text', () => {
    const stored = resolveExtraSystemPrompt(undefined, project, NEW);
    expect(withCurrentGlobalInstructions(stored, NEW)).toBe(stored);
  });

  it('replaces edited text and keeps every part after it', () => {
    const stored = [resolveExtraSystemPrompt(undefined, project, OLD), READ_ONLY_PROMPT].join('\n\n---\n\n');
    const next = withCurrentGlobalInstructions(stored, NEW)!;
    expect(next).not.toContain(OLD);
    expect(next.split(NEW)).toHaveLength(2);
    expect(next).toContain(`${PROJECT_INSTRUCTIONS_HEADING}\n\n${project}`);
    expect(next.endsWith(READ_ONLY_PROMPT)).toBe(true);
    expect(withCurrentGlobalInstructions(resolveExtraSystemPrompt(undefined, undefined, OLD), NEW))
      .toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}`);
  });

  it('adds them to a run started before they were set, and drops them once cleared', () => {
    expect(withCurrentGlobalInstructions(project, NEW)).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}\n\n---\n\n${project}`);
    expect(withCurrentGlobalInstructions(undefined, NEW)).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}`);
    expect(withCurrentGlobalInstructions(resolveExtraSystemPrompt(undefined, project, OLD), undefined)).toBe(`${PROJECT_INSTRUCTIONS_HEADING}\n\n${project}`);
    expect(withCurrentGlobalInstructions(undefined, '  ')).toBeUndefined();
  });
});

describe('a task session after the global instructions change', { timeout: 20_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    sessions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-global-refresh-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'README'), 'start\n');
    execFileSync('git', ['add', 'README'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'initial'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
  });

  afterEach(async () => {
    for (const { id } of store.listRuns()) manager.cancel(id);
    for (const session of sessions) session.settle();
    await vi.waitFor(() => expect(store.listRuns().some(({ id }) => manager.isActive(id))).toBe(false), wait);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.unstubAllEnvs();
  });

  const expectCurrent = (spec: AgentRunSpec | undefined) => {
    expect(spec?.systemPrompt).not.toContain(OLD);
    expect(spec?.systemPrompt?.split(NEW)).toHaveLength(2);
    expect(spec?.systemPrompt).toContain(GLOBAL_INSTRUCTIONS_HEADING);
  };

  it.each([OLD, undefined])('Continue gets the current text (started with %s)', async (before) => {
    if (before) await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = before; });
    const { id } = manager.startRun({ name: 'one', source: 'file', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] }, { task: 'do it', worktree: false });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = NEW; });
    expect(manager.continueRun(id, { text: 'one more thing' }).ok).toBe(true);
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expectCurrent(sessions[1]!.spec);
  });

  it('a workflow handed to another agent mid-step gets the current text on every remaining step', async () => {
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = OLD; });
    const { id } = manager.startRun(workflow, { task: 'implement it', runner: 'claude', worktree: false });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]!.spec.systemPrompt).toContain(OLD);
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = NEW; });
    expect(manager.switchAgent(id, { runner: 'codex', agentProfile: 'default', changedBy: 'test' })).toHaveProperty('summary');
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expectCurrent(sessions[1]!.spec);
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expectCurrent(sessions[2]!.spec);
  });
});
