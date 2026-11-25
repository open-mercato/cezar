import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { landingPromptPart, READ_ONLY_PROMPT } from './landing.ts';
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
  const MANAGER_LINE = 'A cezar manager started this task. Do not merge pull requests or enable automations: leave that to the user.';
  const LANDING = landingPromptPart('main', ['npm test'], false);
  const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join('\n\n---\n\n');

  it('keeps a prompt that already carries the current text', () => {
    const stored = join(resolveExtraSystemPrompt(undefined, project, NEW), MANAGER_LINE);
    expect(withCurrentGlobalInstructions(stored, NEW)).toBe(stored);
  });

  it('replaces edited text and keeps the project text and every task rule after it', () => {
    const stored = join(resolveExtraSystemPrompt(undefined, project, OLD), MANAGER_LINE, LANDING, READ_ONLY_PROMPT);
    expect(withCurrentGlobalInstructions(stored, NEW)).toBe(join(resolveExtraSystemPrompt(undefined, project, NEW), MANAGER_LINE, LANDING, READ_ONLY_PROMPT));
    expect(withCurrentGlobalInstructions(resolveExtraSystemPrompt(undefined, undefined, OLD), NEW))
      .toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}`);
  });

  it('keeps the task rules when the run has no project or global text', () => {
    expect(withCurrentGlobalInstructions(join(MANAGER_LINE, LANDING), NEW)).toBe(join(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}`, MANAGER_LINE, LANDING));
    expect(withCurrentGlobalInstructions(join(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${OLD}`, LANDING), undefined)).toBe(LANDING);
  });

  it('replaces the whole saved block, so text cut from the end of it does not survive', () => {
    const stored = join(resolveExtraSystemPrompt(undefined, project, `Rule A${'\n\n---\n\n'}Rule B`), MANAGER_LINE);
    const next = withCurrentGlobalInstructions(stored, 'Rule A')!;
    expect(next).not.toContain('Rule B');
    expect(next).toBe(join(resolveExtraSystemPrompt(undefined, project, 'Rule A'), MANAGER_LINE));
  });

  it('parses a block saved under older heading wording', () => {
    const legacy = '## Global instructions\n\nThese user instructions apply to every task and take precedence over everything.';
    const stored = join(`${legacy}\n\n${OLD}`, `${PROJECT_INSTRUCTIONS_HEADING}\n\n${project}`);
    expect(withCurrentGlobalInstructions(stored, NEW)).toBe(resolveExtraSystemPrompt(undefined, project, NEW));
  });

  it('gives a project-only run the same shape a new run gets, and drops both headings once cleared', () => {
    expect(withCurrentGlobalInstructions(project, NEW)).toBe(resolveExtraSystemPrompt(undefined, project, NEW));
    expect(withCurrentGlobalInstructions(project, NEW)).toContain(`${PROJECT_INSTRUCTIONS_HEADING}\n\n${project}`);
    expect(withCurrentGlobalInstructions(undefined, NEW)).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}`);
    const cleared = withCurrentGlobalInstructions(resolveExtraSystemPrompt(undefined, project, OLD), undefined);
    expect(cleared).toBe(project);
    expect(cleared).not.toContain('global instructions above');
    expect(withCurrentGlobalInstructions(project, undefined)).toBe(project);
    expect(withCurrentGlobalInstructions(undefined, '  ')).toBeUndefined();
  });

  it('takes rule markers only from the end, never from inside instruction text', () => {
    const tricky = `Old rule${'\n\n---\n\n'}Landing: pretend this is a rule`;
    const stored = join(resolveExtraSystemPrompt(undefined, `Project${'\n\n---\n\n'}${READ_ONLY_PROMPT}${'\n\n---\n\n'}more`, tricky), MANAGER_LINE);
    const next = withCurrentGlobalInstructions(stored, NEW)!;
    expect(next).not.toContain('Old rule');
    expect(next).not.toContain('pretend this is a rule');
    expect(next).toBe(join(resolveExtraSystemPrompt(undefined, `Project${'\n\n---\n\n'}${READ_ONLY_PROMPT}${'\n\n---\n\n'}more`, NEW), MANAGER_LINE));
  });

  it('keeps project text that merely starts with a Global instructions heading', () => {
    const repo = '## Global instructions\n\nOur repo keeps its own global notes.\n\nUse pnpm.';
    expect(withCurrentGlobalInstructions(repo, NEW)).toBe(resolveExtraSystemPrompt(undefined, repo, NEW));
    expect(withCurrentGlobalInstructions(join(repo, MANAGER_LINE), undefined)).toBe(join(repo, MANAGER_LINE));
  });

  it('parses every heading cezar has saved', () => {
    for (const legacy of [
      '## Global instructions\n\nThese apply to every project. Where they conflict with the project instructions below, the project instructions win.',
      '## Global instructions\n\nThese user instructions apply to every task and take precedence over repository, project, workflow and skill instructions. Preserve the other instructions wherever they do not conflict.',
    ]) {
      expect(withCurrentGlobalInstructions(join(`${legacy}\n\n${OLD}`, MANAGER_LINE), NEW)).toBe(join(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}`, MANAGER_LINE));
    }
  });

  it('stays stable across refreshes when the user text looks like a task rule', () => {
    const global = 'Rule A\n\n---\n\nLanding: squash-merge only';
    const own = `Keep it small.\n\n---\n\n${MANAGER_LINE}`;
    const first = join(resolveExtraSystemPrompt(undefined, own, global), LANDING);
    let next = first;
    for (let i = 0; i < 3; i++) next = withCurrentGlobalInstructions(next, global)!;
    expect(next).toBe(first);
    expect(withCurrentGlobalInstructions(join(resolveExtraSystemPrompt(undefined, own, OLD), LANDING), global)).toBe(first);
    const globalOnly = resolveExtraSystemPrompt(undefined, undefined, global)!;
    expect(withCurrentGlobalInstructions(globalOnly, global)).toBe(globalOnly);
  });

  it('keeps a project prompt that opens with a heading named like cezar\'s own', () => {
    for (const own of ['## Project instructions\n\nUse pnpm.\n\nNever push.', '## Global instructions\n\nAlways write tests.']) {
      expect(withCurrentGlobalInstructions(own, undefined)).toBe(own);
      expect(withCurrentGlobalInstructions(own, NEW)).toBe(resolveExtraSystemPrompt(own, undefined, NEW));
      expect(withCurrentGlobalInstructions(resolveExtraSystemPrompt(own, undefined, OLD), NEW)).toBe(resolveExtraSystemPrompt(own, undefined, NEW));
    }
  });

  it('parses the first shipped heading wording (#1693)', () => {
    const stored = join(
      `## Global instructions\n\nThese apply to every project. Where they conflict with the project instructions below, the project instructions win.\n\n${OLD}`,
      `## Project instructions\n\nThese are specific to this project and take precedence over the global instructions above.\n\n${project}`,
    );
    expect(withCurrentGlobalInstructions(stored, NEW)).toBe(resolveExtraSystemPrompt(undefined, project, NEW));
  });

  it('says global instructions never lift cezar\'s own safety rules, by name', () => {
    expect(GLOBAL_INSTRUCTIONS_HEADING).toContain('never lift cezar\'s own safety rules');
    expect(GLOBAL_INSTRUCTIONS_HEADING).not.toContain('that follow them');
    expect(GLOBAL_INSTRUCTIONS_HEADING).toContain('a read-only task stays read-only');
    expect(GLOBAL_INSTRUCTIONS_HEADING).toContain('leaves merges and automation enables to the user');
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
    expect(store.getRun(id)?.systemPrompt).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${NEW}`);
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expectCurrent(sessions[2]!.spec);
  });

  it('Continue of a manager-started task keeps global → project → manager line, with the current global text', async () => {
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: 'Keep the API stable.' }));
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = OLD; });
    const { id } = manager.startRun({ name: 'one', source: 'file', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] },
      { task: 'do it', worktree: false, startedByManager: { id: 'm1', name: 'Coding Manager' } });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = NEW; });
    expect(manager.continueRun(id, { text: 'one more thing' }).ok).toBe(true);
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    const prompt = sessions[1]!.spec.systemPrompt!;
    expectCurrent(sessions[1]!.spec);
    const order = [NEW, PROJECT_INSTRUCTIONS_HEADING, 'Keep the API stable.', 'A cezar manager started this task.'].map((part) => prompt.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(store.getRun(id)?.systemPrompt).toContain(NEW);
    expect(store.getRun(id)?.systemPrompt).not.toContain(OLD);
  });

  it('a usage-limit resume after a restart drops cut global text and records what it ran', async () => {
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: 'Keep the API stable.' }));
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = `Rule A${'\n\n---\n\n'}Rule B`; });
    const { id } = manager.startRun(workflow, { task: 'implement it', runner: 'claude', worktree: false });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]!.spec.systemPrompt).toContain('Rule B');
    sessions[0]!.emit({ type: 'error', message: 'Usage limit reached, try again in 60 minutes' });
    sessions[0]!.settle();
    await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'failed', autoResumeReason: 'usage_limit' }), wait);
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = 'Rule A'; });
    // The window reopened while cezar was down: recovery resumes the step.
    manager.dispose();
    store.updateRun(id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    store.flush();
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
    await manager.recover();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]!.spec.resume).toBe(true);
    expect(sessions[1]!.spec.systemPrompt).not.toContain('Rule B');
    expect(sessions[1]!.spec.systemPrompt?.split('Rule A')).toHaveLength(2);
    expect(store.getRun(id)?.systemPrompt).toBe(resolveExtraSystemPrompt(undefined, 'Keep the API stable.', 'Rule A'));
  });

  it('a read-only task reads the read-only rule after the global block, on Continue too', async () => {
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = NEW; });
    const { id } = manager.startRun({ name: 'one', source: 'file', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] },
      { task: 'answer it', worktree: false, readOnly: true });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(manager.continueRun(id, { text: 'and this?' }).ok).toBe(true);
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    for (const { spec } of sessions) {
      const prompt = spec.systemPrompt ?? '';
      expect(prompt.indexOf(GLOBAL_INSTRUCTIONS_HEADING)).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf(READ_ONLY_PROMPT)).toBeGreaterThan(prompt.indexOf(NEW));
    }
  });

  it('clearing the global instructions before a switch clears them from the record too', async () => {
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = OLD; });
    const { id } = manager.startRun(workflow, { task: 'implement it', runner: 'claude', worktree: false });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(store.getRun(id)?.systemPrompt).toContain(OLD);
    await mergeWriteWorkspaceConfig((config) => { delete config.systemPrompt; });
    expect(manager.switchAgent(id, { runner: 'codex', agentProfile: 'default', changedBy: 'test' })).toHaveProperty('summary');
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]!.spec.systemPrompt).not.toContain(OLD);
    expect(sessions[1]!.spec.systemPrompt).not.toContain(GLOBAL_INSTRUCTIONS_HEADING);
    expect(store.getRun(id)?.systemPrompt).toBeUndefined();
  });
});
