import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { artifactsDir, RunStore } from '../runs/store.ts';
import { agentDirectories, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const sessions = vi.hoisted(() => [] as { spec: AgentRunSpec; emit: (event: AgentEvent) => void; end: () => void }[]);
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    startSession: (spec: AgentRunSpec, emit: (event: AgentEvent) => void) => {
      let end = () => {};
      let open = true;
      const result = new Promise<AgentRunResult>((resolve) => {
        end = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      });
      sessions.push({ spec, emit, end });
      return { result, get open() { return open; }, sendMessage: () => true, end, interrupt: end };
    },
  }),
}));

const TASK: WorkflowDef = { name: 'one-step', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }] };
const ATTACHMENT = { type: 'file' as const, mediaType: 'text/plain', data: Buffer.from('brief').toString('base64'), name: 'brief.txt' };

describe('stage-only directory grants', () => {
  let root: string;
  let dataDir: string;
  let libraryDir: string;
  let outputDir: string;
  let runId: string;
  let store: RunStore;
  let manager: RunManager;
  let internals: {
    active: Map<string, { grantedAttachmentLibrary?: string }>;
    runAgentStep: (...args: unknown[]) => Promise<string | null>;
  };

  beforeEach(async () => {
    sessions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-stage-only-grants-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    dataDir = join(root, '.ai/cezar');
    libraryDir = join(dataDir, 'attachments');
    outputDir = join(dataDir, 'runs', 'phase-output');
    mkdirSync(outputDir, { recursive: true });
    store = RunStore.open(dataDir);
    manager = new RunManager(store, root);
    internals = manager as unknown as typeof internals;
    runId = manager.startRun(TASK, { task: 'hold', runner: 'claude', worktree: false, images: [ATTACHMENT] }).id;
    store.updateRun(runId, { dispatch: { rootRunId: runId } });
    await expect.poll(() => sessions.length).toBe(1);
  });

  afterEach(async () => {
    manager.cancel(runId);
    for (const session of sessions) session.end();
    await expect.poll(() => manager.isActive(runId)).toBe(false);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  async function phase(stageOnly: boolean) {
    store.updateRun(runId, { harness: { workflow: 'harness-fix-issue', profile: 'standard', issueId: '1' } });
    store.addStep(runId, { id: 'implement', name: 'Implement', kind: 'agent' });
    const resultPath = join(outputDir, 'result.json');
    writeFileSync(resultPath, '{}');
    const pending = internals.runAgentStep(runId, internals.active.get(runId),
      { id: 'implement', prompt: 'implement' }, { task: 'x', worktree: false }, [], null, false,
      () => {}, undefined, 'claude', undefined, undefined,
      [{ name: 'brief.txt', url: '/api/v1/attachment', path: join(dataDir, 'runs', `${runId}-images`, 'pasted-1.txt') }], undefined,
      { concurrent: true, resultPath, env: { CEZ_HARNESS_STAGE_ONLY: stageOnly ? '1' : '0', CEZ_HARNESS_OUTPUT_DIR: outputDir } });
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'turn-end' });
    expect(await pending).toBeNull();
    return sessions[1]!.spec;
  }

  it('grants a stage-only phase only its output and per-run TMPDIR, even with a library, dispatch tree and artifacts', async () => {
    const spec = await phase(true);
    expect(spec.env?.CEZ_TREE_DIR).toBeTruthy();
    expect(spec.env?.CEZ_ARTIFACTS_DIR).toBe(artifactsDir(dataDir, runId));
    expect(spec.additionalDirectories).toEqual([outputDir, spec.env!.TMPDIR]);
    expect(spec.systemPrompt).not.toContain(artifactsDir(dataDir, runId));
  });

  it('does not advertise the attachment library to a stage-only phase', async () => {
    const spec = await phase(true);
    expect(spec.userPrompt).not.toContain(libraryDir);
    expect(internals.active.get(runId)?.grantedAttachmentLibrary).toBeUndefined();
  });

  it('guard: a non-stage-only harness invocation keeps the library, TMPDIR, tree and library hint', async () => {
    const spec = await phase(false);
    expect(spec.additionalDirectories).toEqual([join(dataDir, 'runs'), libraryDir, spec.env!.TMPDIR, spec.env!.CEZ_TREE_DIR, artifactsDir(dataDir, runId)]);
    expect(spec.userPrompt).toContain(`kept under their original names in ${libraryDir}`);
    expect(spec.systemPrompt).toContain(artifactsDir(dataDir, runId));
  });

  it('guard: an ordinary opening and Continue keep the library, TMPDIR, tree and library hint', async () => {
    const opening = sessions[0]!.spec;
    expect(opening.additionalDirectories).toEqual([join(dataDir, 'runs'), libraryDir, opening.env!.TMPDIR, opening.env!.CEZ_TREE_DIR, artifactsDir(dataDir, runId)]);
    expect(opening.userPrompt).toContain(`kept under their original names in ${libraryDir}`);
    expect(opening.systemPrompt).toContain(artifactsDir(dataDir, runId));
    sessions[0]!.end();
    await expect.poll(() => manager.isActive(runId)).toBe(false);
    expect(manager.continueRun(runId, { text: 'more', images: [ATTACHMENT] })).toEqual({ ok: true });
    await expect.poll(() => sessions.length).toBe(2);
    const continued = sessions[1]!.spec;
    expect(continued.additionalDirectories).toEqual([join(dataDir, 'runs'), libraryDir, continued.env!.TMPDIR, continued.env!.CEZ_TREE_DIR, artifactsDir(dataDir, runId)]);
    expect(continued.userPrompt).toContain(`kept under their original names in ${libraryDir}`);
    expect(continued.systemPrompt).toContain(artifactsDir(dataDir, runId));
  });
});

describe('agentDirectories stage-only boundary', () => {
  it('excludes the attachment library, dispatch tree and artifacts from stage-only grants', () => {
    expect(agentDirectories('/data/runs', '/data/attachments', {
      CEZ_HARNESS_STAGE_ONLY: '1', CEZ_HARNESS_OUTPUT_DIR: '/data/output', TMPDIR: '/data/tmp', CEZ_TREE_DIR: '/data/tree',
      CEZ_ARTIFACTS_DIR: '/data/artifacts',
    })).toEqual(['/data/output', '/data/tmp']);
  });

  it.each([undefined, '0'])('guard: keeps ordinary directory order with stage-only=%s', (stageOnly) => {
    expect(agentDirectories('/data/runs', '/data/attachments', {
      ...(stageOnly ? { CEZ_HARNESS_STAGE_ONLY: stageOnly } : {}),
      CEZ_HARNESS_OUTPUT_DIR: '/data/output', TMPDIR: '/data/tmp', CEZ_TREE_DIR: '/data/tree',
      CEZ_ARTIFACTS_DIR: '/data/artifacts',
    })).toEqual(['/data/runs', '/data/attachments', '/data/tmp', '/data/tree', '/data/artifacts']);
  });
});
