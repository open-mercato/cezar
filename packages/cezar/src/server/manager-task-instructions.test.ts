import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import type { ManagerEngine } from '../managers/engine.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { composeDispatchPrompt } from '../dispatch/prompts.ts';
import { RunManager } from '../workflows/run.ts';
import * as pullRequests from './pr.ts';
import { createApp } from './server.ts';

const GLOBAL = 'Do not run the full test suite. Run only focused tests.';
const PROJECT = 'Keep the project API compatible.';
const SKILL = 'Inspect the changed module before editing.';
const GUARD = 'Do not merge pull requests or enable automations';
const BASE = '/api/v1/workspace/managers';

describe('manager task instruction propagation through the HTTP API and workflow engine', () => {
  let root: string;
  let store: RunStore;
  let runs: RunManager;
  let engine: ManagerEngine;
  let app: ReturnType<typeof createApp>;
  let specs: AgentRunSpec[];
  let sessions: AgentSession[];

  const request = (path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1' }, body: JSON.stringify(body),
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-manager-instructions-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    vi.stubEnv('CEZ_DISPATCH', '1');
    vi.stubEnv('CEZ_API_URL', 'http://127.0.0.1:4321');
    vi.stubEnv('CEZ_AUTOMATIONS', '0');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, timeout: 10_000 });
    writeFileSync(join(root, 'file.txt'), 'base\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
    execFileSync('git', ['add', 'file.txt', 'package.json'], { cwd: root, timeout: 10_000 });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root, timeout: 10_000 });
    mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    mkdirSync(join(root, '.ai/skills/instruction-check'), { recursive: true });
    writeFileSync(join(root, '.ai/skills/instruction-check/SKILL.md'), `---\nname: instruction-check\n---\n${SKILL}\n`);
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: PROJECT }));
    writeFileSync(join(root, '.ai/cezar/workflows/instructions.yaml'), [
      'name: instructions', 'steps:', '  - id: first', '    skill: instruction-check', '    prompt: "{{task}}"',
      '    runner: codex', '  - id: second', '    prompt: "{{task}}"', '    runner: claude',
      '  - id: verify', '    command: "true"',
    ].join('\n'));
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = GLOBAL; });
    specs = [];
    sessions = [];
    for (const prototype of [ClaudeCliRunner.prototype, CodexAppServerRunner.prototype]) {
      const start = prototype.startSession;
      vi.spyOn(prototype, 'startSession').mockImplementation(function (this: typeof prototype, ...args) {
        specs.push(args[0]);
        const session = start.apply(this, args);
        sessions.push(session);
        return session;
      });
    }
    store = RunStore.open(join(root, '.ai/cezar'));
    runs = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) });
    app = createApp({ repoRoot: root, version: 'test', store, manager: runs, onManagerEngine: (built) => { engine = built; } });
  });

  afterEach(async () => {
    try {
      await engine.shutdown();
      for (const run of store.listRuns()) runs.cancel(run.id);
      runs.dispose();
      for (const session of sessions) session.interrupt();
      await Promise.allSettled(sessions.map((session) => session.result));
      store.flush();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  async function createTask(workflow: string, runner: 'claude' | 'codex', text = 'Fix the module mock:done') {
    const created = await request(BASE, { instructions: 'Help with tasks', projects: 'all', cronMinutes: 0 });
    expect(created.status).toBe(201);
    const manager = await created.json() as { id: string; connectedProjectIds: string[] };
    await engine.update(manager.id, { followUp: false, notify: false });
    const projectId = manager.connectedProjectIds[0];
    const response = await request(`${BASE}/${manager.id}/tasks`, { projectId, task: text, workflow, runner });
    expect(response.status).toBe(201);
    const task = await response.json() as { runId: string };
    return { ...task, managerId: manager.id, projectId };
  }

  it.each([undefined, 'https://github.com/open-mercato/demo/pull/42'])(
    'answers the built-in review gate via task say before publishing (existing PR: %s)', async (existing) => {
    const publish = vi.spyOn(pullRequests, 'createDraftPr');
    const { managerId, projectId, runId } = await createTask('implement-review-pr', 'claude', 'Fix the module mock:verdict=approve');
    const record = () => store.getRun(runId);
    await expect.poll(() => record()?.steps.find((step) => step.id === 'gate')?.status, { timeout: 20_000 }).toBe('waiting');
    expect(record()?.pullRequestUrl).toBeUndefined();
    if (existing) store.updateRun(runId, { pullRequestUrl: existing });

    const text = 'Recheck the changelog and open a full PR. mock:verdict=applied';
    const response = await request(`${BASE}/${managerId}/task-message`, { projectId, runId, text });
    expect(response.status).toBe(200);
    await expect.poll(() => record()?.status, { timeout: 20_000 }).toMatch(/^(done|review|failed)$/);
    expect(record()).toMatchObject({
      status: expect.stringMatching(/^(done|review)$/),
      pullRequestUrl: existing ?? 'https://github.com/open-mercato/demo/pull/777',
    });
    expect(record()?.error).toBeUndefined();
    expect(record()?.steps.map((step) => [step.id, step.status])).toContainEqual(['pr', 'done']);
    expect(specs.at(-1)?.userPrompt).toContain(text);
    expect(specs.at(-1)?.userPrompt).toContain('ready for review');
    expect(specs.at(-1)?.resume).toBe(true);
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      draft: false, ...(existing ? { updateExisting: true } : {}),
    }));
    expect(publish.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(ClaudeCliRunner.prototype.startSession).mock.invocationCallOrder.at(-1)!,
    );
  }, 40_000);

  function assertInstructions(spec: AgentRunSpec, global = GLOBAL, project = PROJECT) {
    expect(spec.systemPrompt?.split(GLOBAL)).toHaveLength(2);
    expect(spec.systemPrompt?.split(PROJECT)).toHaveLength(2);
    expect(spec.systemPrompt?.split(global)).toHaveLength(2);
    expect(spec.systemPrompt?.split(project)).toHaveLength(2);
    expect(spec.systemPrompt?.split(GUARD)).toHaveLength(2);
    expect(spec.systemPrompt).toContain('take precedence over repository, project, workflow and skill instructions');
  }

  it('preserves global, project and skill instructions across workflow backend changes and manager Continue', async () => {
    const task = await createTask('instructions', 'codex');
    await expect.poll(() => store.getRun(task.runId)?.status, { timeout: 20_000 }).toMatch(/done|review/);
    const first = specs.filter((spec) => spec.cwd === store.getRun(task.runId)?.worktreePath);
    expect(first).toHaveLength(2);
    for (const spec of first) assertInstructions(spec);
    expect(first[0]?.systemPrompt).toContain(SKILL);
    const previousCount = specs.length;
    const response = await request(`${BASE}/${task.managerId}/task-message`, { projectId: task.projectId, runId: task.runId, text: 'Continue mock:done' });
    expect(response.status).toBe(200);
    await expect.poll(() => specs.length, { timeout: 20_000 }).toBeGreaterThan(previousCount);
    const continued = specs.at(-1);
    if (!continued) throw new Error('missing continued session');
    assertInstructions(continued);
    await expect.poll(() => store.getRun(task.runId)?.status, { timeout: 20_000 }).toMatch(/waiting|done|review/);
  }, 45_000);

  it('preserves instructions when a workflow node spawns a sub-workflow', async () => {
    writeFileSync(join(root, '.ai/cezar/workflows/spawn.yaml'), JSON.stringify({
      version: 2, name: 'spawn',
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'child', type: 'workflow', workflow: 'instructions', runner: 'codex', prompt: '{{task}}' },
        { id: 'end', type: 'end', status: 'success' },
      ],
      edges: [{ from: 'start', to: 'child' }, { from: 'child.done', to: 'end' }],
    }));
    const parent = await createTask('spawn', 'claude');
    await expect.poll(() => store.getRun(parent.runId)?.status, { timeout: 20_000 }).toMatch(/done|review|failed/);
    expect(store.getRun(parent.runId)?.status, JSON.stringify(store.getRun(parent.runId))).toMatch(/done|review/);
    const children = store.listRuns().filter((run) => run.dispatch?.parentRunId === parent.runId);
    expect(children).toHaveLength(1);
    const child = children[0];
    const childSpecs = specs.filter((spec) => spec.cwd === child?.worktreePath);
    expect(childSpecs).toHaveLength(2);
    for (const spec of childSpecs) assertInstructions(spec);
    expect(childSpecs[0]?.systemPrompt).toContain(SKILL);
  }, 45_000);

  it.each(['claude', 'codex'] as const)('propagates current instructions and manager restrictions to a dispatched %s child exactly once', async (runner) => {
    const parent = await createTask('quick-task', 'claude');
    await expect.poll(() => store.getRun(parent.runId)?.status, { timeout: 20_000 }).toMatch(/done|review/);
    // Dispatch requires a live parent. Reopen it with a turn that waits for user input.
    expect(runs.continueRun(parent.runId, { text: 'Keep investigating' }).ok).toBe(true);
    await expect.poll(() => store.getRun(parent.runId)?.status, { timeout: 20_000 }).toBe('waiting');
    const global = `${GLOBAL} Use the updated global guidance.`;
    const project = `${PROJECT} Use the updated project guidance.`;
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = global; });
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: project }));
    if (runner === 'claude') delete process.env.CEZ_API_URL;
    const child = runs.dispatch(parent.runId, { objective: 'Investigate independently mock:done', runner, kind: 'review' }, {
      workflow: { name: '(planned)', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }, { id: 'verify', command: 'true' }] },
    });
    if ('refused' in child) throw new Error(child.refused);
    await expect.poll(() => specs.some((spec) => spec.cwd === store.getRun(child.id)?.worktreePath), { timeout: 20_000 }).toBe(true);
    const spec = specs.find((candidate) => candidate.cwd === store.getRun(child.id)?.worktreePath);
    if (!spec) throw new Error('missing child session');
    assertInstructions(spec, global, project);
    expect(spec.systemPrompt?.split(composeDispatchPrompt('review'))).toHaveLength(2);
    await expect.poll(() => store.getRun(child.id)?.status, { timeout: 20_000 }).toMatch(/done|review/);
  }, 45_000);
});
