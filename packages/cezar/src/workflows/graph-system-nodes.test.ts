import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { graphIssues, graphRailSteps, graphToSteps, type WorkflowGraph } from './graph.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Phase-1c nodes end to end (spec 2026-09-30-workflow-node-editor): nodes cezar runs itself,
 * with a real RunManager, the bundled mock agent and `CEZ_DRY_RUN=1` GitHub fakes.
 */
describe('graph system nodes', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-graph-sys-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    // A real repo gets `.ai/cezar/.gitignore` from `ensureDataGitignore`; this bare one must not
    // let `git.commit` sweep cezar's own run state into the branch.
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const def = (graph: WorkflowGraph): WorkflowDef => {
    expect(graphIssues(graph)).toEqual([]);
    return { name: 'graph', source: 'file', steps: graphToSteps(graph), graph };
  };

  async function until(id: string, pred: (r: RunRecord) => boolean, ms = 20_000): Promise<RunRecord> {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = store.getRun(id);
      if (r && pred(r)) return r;
      if (Date.now() > deadline) throw new Error(`timed out; status=${r?.status} steps=${JSON.stringify(r?.steps.map((s) => [s.id, s.status]))}`);
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  const terminal = (r: RunRecord) => ['done', 'review', 'failed', 'cancelled'].includes(r.status);
  const parkedAt = (node: string) => (r: RunRecord) =>
    r.status === 'waiting' && r.steps.find((s) => s.id === node)?.status === 'waiting';

  const GATE: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'gate', type: 'gate.human', message: 'Ship {{task}}?' },
      { id: 'yes', type: 'check', command: 'echo "approved: {{nodes.gate.comment}}" > gate.txt' },
      { id: 'no', type: 'check', command: 'echo "rejected: {{nodes.gate.comment}}" > gate.txt' },
    ],
    edges: [
      { from: 'start', to: 'gate' },
      { from: 'gate.approve', to: 'yes' },
      { from: 'gate.reject', to: 'no' },
    ],
  };

  it('a human gate parks the run (waiting, askParked), shows an ask card, and approves on "Approve"', async () => {
    const id = manager.startRun(def(GATE), { task: 'the fix', worktree: false }).id;
    const parked = await until(id, parkedAt('gate'));
    expect(parked.askParked).toBe(true);
    const events = readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8');
    expect(events).toContain('"ask.requested"');
    expect(events).toContain('Ship the fix?');

    expect(manager.sendMessage(id, [{ type: 'text', text: 'Approve' }])).toBe(true);
    const final = await until(id, terminal);
    expect(final.status).not.toBe('failed');
    expect(readFileSync(join(repoRoot, 'gate.txt'), 'utf8')).toBe('approved: Approve\n');
    expect(final.steps.map((s) => [s.id, s.status])).toEqual([
      ['gate', 'done'],
      ['yes', 'done'],
      ['no', 'pending'],
    ]);
  }, 30_000);

  it('a click on the card ("<header>: Approve") approves — the card framing is not the answer', async () => {
    const named: WorkflowGraph = { ...GATE, nodes: GATE.nodes.map((n) => (n.id === 'gate' ? { ...n, name: 'Release gate' } : n)) };
    const id = manager.startRun(def(named), { task: 'x', worktree: false }).id;
    await until(id, parkedAt('gate'));
    manager.sendMessage(id, [{ type: 'text', text: 'Release gate: Approve' }]);
    await until(id, terminal);
    expect(readFileSync(join(repoRoot, 'gate.txt'), 'utf8')).toBe('approved: Approve\n');
  }, 30_000);

  it('any other answer rejects, and the reply becomes the comment', async () => {
    const id = manager.startRun(def(GATE), { task: 'x', worktree: false }).id;
    await until(id, parkedAt('gate'));
    manager.sendMessage(id, [{ type: 'text', text: 'Reject — tests are flaky' }]);
    await until(id, terminal);
    expect(readFileSync(join(repoRoot, 'gate.txt'), 'utf8')).toBe('rejected: Reject — tests are flaky\n');
  }, 30_000);

  it('Finish at a gate settles the run without running what follows; cancel cancels it', async () => {
    const a = manager.startRun(def(GATE), { task: 'x', worktree: false }).id;
    await until(a, parkedAt('gate'));
    expect(manager.finish(a)).toBe(true);
    const finished = await until(a, terminal);
    expect(['done', 'review']).toContain(finished.status);
    expect(existsSync(join(repoRoot, 'gate.txt'))).toBe(false);

    const b = manager.startRun(def(GATE), { task: 'x', worktree: false }).id;
    await until(b, parkedAt('gate'));
    expect(manager.cancel(b)).toBe(true);
    expect((await until(b, terminal)).status).toBe('cancelled');
  }, 30_000);

  it('a parked gate gives its maxParallel slot back — another task runs meanwhile', async () => {
    manager.dispose();
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
    const gated = manager.startRun(def(GATE), { task: 'x', worktree: true }).id;
    await until(gated, parkedAt('gate'));
    const quick: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}} mock:done' }] };
    const other = manager.startRun(quick, { task: 'meanwhile', worktree: true }).id;
    expect(terminal(await until(other, terminal))).toBe(true);
    expect(store.getRun(gated)?.status).toBe('waiting');
    manager.cancel(gated);
    await until(gated, terminal);
  }, 40_000);

  it('a gate survives a restart: the walk resumes AT the gate, with earlier outputs kept', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'first', type: 'check', command: 'echo first-output' },
        { id: 'gate', type: 'gate.human', message: 'Ship?' },
        { id: 'after', type: 'check', command: 'echo "{{nodes.first.output}} / {{nodes.gate.comment}}" > resumed.txt' },
      ],
      edges: [
        { from: 'start', to: 'first' },
        { from: 'first', to: 'gate' },
        { from: 'gate.approve', to: 'after' },
      ],
    }
    const id = manager.startRun(def(graph), { task: 'x', worktree: false }).id;
    await until(id, parkedAt('gate'));
    expect(store.getRun(id)?.graphState?.cursor).toBe('gate');

    // The process goes away with the run parked at the gate…
    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot);
    await manager.recover();

    // …and comes back parked at the SAME gate, not failed, and without re-running `first`.
    const back = await until(id, parkedAt('gate'));
    expect(back.steps.find((s) => s.id === 'first')?.iterations).toBe(1);
    manager.sendMessage(id, [{ type: 'text', text: 'Approve' }]);
    const final = await until(id, terminal);
    expect(final.status).not.toBe('failed');
    expect(readFileSync(join(repoRoot, 'resumed.txt'), 'utf8')).toBe('first-output / Approve\n');
  }, 40_000);

  it('ask-user feeds the answer into later nodes', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ask', type: 'ask-user', question: 'Which library?', options: ['date-fns', 'luxon'] },
        { id: 'use', type: 'check', command: 'echo "{{nodes.ask.answer}}" > answer.txt' },
      ],
      edges: [
        { from: 'start', to: 'ask' },
        { from: 'ask', to: 'use' },
      ],
    };
    const id = manager.startRun(def(graph), { task: 'x', worktree: false }).id;
    await until(id, parkedAt('ask'));
    manager.sendMessage(id, [{ type: 'text', text: 'luxon' }]);
    await until(id, terminal);
    expect(readFileSync(join(repoRoot, 'answer.txt'), 'utf8')).toBe('luxon\n');
  }, 30_000);

  it('git.commit commits the agent work with the rendered message, then reports nothing', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'work', type: 'agent', prompt: '{{task}}' },
        { id: 'commit', type: 'git.commit', message: 'feat: {{task}}' },
        { id: 'again', type: 'git.commit', message: 'nothing left' },
        { id: 'log', type: 'check', command: 'echo "{{nodes.commit.sha}}" > sha.txt' },
      ],
      edges: [
        { from: 'start', to: 'work' },
        { from: 'work', to: 'commit' },
        { from: 'commit.done', to: 'again' },
        { from: 'again.nothing', to: 'log' },
      ],
    };
    const id = manager.startRun(def(graph), { task: 'add notes', worktree: false }).id;
    const final = await until(id, terminal);
    expect(final.status).not.toBe('failed');
    const { stdout } = await run('git', ['log', '-1', '--format=%H %s'], { cwd: repoRoot });
    expect(stdout.trim()).toBe(`${readFileSync(join(repoRoot, 'sha.txt'), 'utf8').trim()} feat: add notes`);
  }, 30_000);

  it('draft PR → PR comment → wait for CI, faked under CEZ_DRY_RUN', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'work', type: 'agent', prompt: '{{task}}' },
        { id: 'pr', type: 'github.draft-pr', title: 'Graph PR for {{task}}' },
        { id: 'comment', type: 'github.pr-comment', body: 'Opened {{nodes.pr.url}}' },
        { id: 'ci', type: 'github.wait-ci', timeoutMs: 60_000, pollMs: 10_000 },
        { id: 'ok', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'work' },
        { from: 'work', to: 'pr' },
        { from: 'pr.created', to: 'comment' },
        { from: 'comment', to: 'ci' },
        { from: 'ci.green', to: 'ok' },
      ],
    };
    const id = manager.startRun(def(graph), { task: 'ship it', worktree: true }).id;
    const final = await until(id, terminal, 30_000);
    expect(final.status).not.toBe('failed');
    expect(final.pullRequestUrl).toBe('https://github.com/open-mercato/demo/pull/777');
    expect(final.steps.map((s) => [s.id, s.status])).toEqual([
      ['work', 'done'],
      ['pr', 'done'],
      ['comment', 'done'],
      ['ci', 'done'],
    ]);
  }, 40_000);

  it('wait-ci with no PR takes red; the rail lists system nodes as check rows', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ci', type: 'github.wait-ci', timeoutMs: 60_000, pollMs: 10_000 },
        { id: 'fallback', type: 'check', command: 'true' },
      ],
      edges: [
        { from: 'start', to: 'ci' },
        { from: 'ci.red', to: 'fallback' },
      ],
    };
    expect(graphRailSteps(graph)).toEqual([
      { id: 'ci', name: 'Wait for CI', kind: 'check' },
      { id: 'fallback', name: 'fallback', kind: 'check' },
    ]);
    const final = await until(manager.startRun(def(graph), { task: 'x', worktree: false }).id, terminal);
    expect(final.steps.map((s) => [s.id, s.status])).toEqual([
      ['ci', 'failed'],
      ['fallback', 'done'],
    ]);
  }, 30_000);

  it('dispatch waits for its child and takes done when the child settles', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'sub', type: 'dispatch', name: 'Write the docs', prompt: 'write docs for {{task}} mock:done' },
        { id: 'after', type: 'check', command: 'echo "{{nodes.sub.status}}" > child.txt' },
      ],
      edges: [
        { from: 'start', to: 'sub' },
        { from: 'sub.done', to: 'after' },
      ],
    };
    const id = manager.startRun(def(graph), { task: 'x', worktree: false }).id;
    const final = await until(id, terminal, 40_000);
    expect(final.status).not.toBe('failed');
    const status = readFileSync(join(repoRoot, 'child.txt'), 'utf8').trim();
    expect(['done', 'review']).toContain(status);
    const children = store.listRuns().filter((r) => r.dispatch?.parentRunId === id);
    expect(children).toHaveLength(1);
  }, 50_000);

  const FORK: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'made', type: 'check', command: 'echo implemented > made.txt' },
      { id: 'council', type: 'fork', branches: 2 },
      { id: 'correctness', type: 'agent', name: 'Correctness', prompt: 'review A mock:done', review: true },
      { id: 'tests', type: 'agent', prompt: 'review B mock:done' },
      { id: 'meet', type: 'join', wait: 'all' },
      { id: 'after', type: 'check', command: 'echo "{{nodes.correctness.status}}+{{nodes.tests.status}}+{{nodes.meet.succeeded}}" > fan.txt' },
    ],
    edges: [
      { from: 'start', to: 'made' },
      { from: 'made.pass', to: 'council' },
      { from: 'council.1', to: 'correctness' },
      { from: 'council.2', to: 'tests' },
      { from: 'correctness.done', to: 'meet' },
      { from: 'tests.done', to: 'meet' },
      { from: 'meet.done', to: 'after' },
    ],
  };

  it('fork runs each branch agent as a subtask, the join waits for all of them', async () => {
    const id = manager.startRun(def(FORK), { task: 'x', worktree: true }).id;
    const final = await until(id, terminal, 60_000);
    expect(final.status).not.toBe('failed');
    const [a, b, n] = readFileSync(join(final.worktreePath as string, 'fan.txt'), 'utf8').trim().split('+');
    expect(['done', 'review']).toContain(a);
    expect(['done', 'review']).toContain(b);
    expect(n).toBe('2');
    const children = store.listRuns().filter((r) => r.dispatch?.parentRunId === id);
    expect(children.map((c) => c.title).sort()).toEqual(['Correctness', 'tests']);
    // Only the branch marked `review` runs as a reviewer of this task's branch.
    expect(children.find((c) => c.title === 'Correctness')?.dispatch).toMatchObject({ kind: 'review', reviewOf: [final.branch] });
    expect(children.find((c) => c.title === 'tests')?.dispatch?.kind).toBeUndefined();
    // Each branch agent is its own row on the rail, and the walk records both paths.
    expect(final.steps.find((s) => s.id === 'correctness')?.status).toBe('done');
    expect(final.graphState?.taken).toEqual(expect.arrayContaining(['council.1->correctness', 'correctness.done->meet', 'meet.done->after']));
    expect(final.graphState?.outputs?.correctness?.runId).toBe(children.find((c) => c.title === 'Correctness')?.id);
  }, 70_000);

  it("fork commits the task's work first, so the branches fork from it", async () => {
    const id = manager.startRun(def(FORK), { task: 'x', worktree: true }).id;
    const final = await until(id, terminal, 60_000);
    const { stdout } = await run('git', ['log', '--format=%s', final.branch as string], { cwd: repoRoot });
    expect(stdout).toContain('cezar autosave (pre-dispatch)');
    // The child's worktree starts from the task branch as it stood at the fork.
    const child = store.listRuns().find((r) => r.dispatch?.parentRunId === id);
    const shown = await run('git', ['show', `${child?.branch}:made.txt`], { cwd: repoRoot });
    expect(shown.stdout.trim()).toBe('implemented');
  }, 70_000);

  it('workflow runs another catalog workflow as a subtask', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'sub', type: 'workflow', workflow: 'quick-task', prompt: 'sub task mock:done' },
        { id: 'after', type: 'check', command: 'echo "{{nodes.sub.status}}" > sub.txt' },
      ],
      edges: [
        { from: 'start', to: 'sub' },
        { from: 'sub.done', to: 'after' },
      ],
    };
    const id = manager.startRun(def(graph), { task: 'x', worktree: false }).id;
    await until(id, terminal, 60_000);
    expect(['done', 'review']).toContain(readFileSync(join(repoRoot, 'sub.txt'), 'utf8').trim());
    const child = store.listRuns().find((r) => r.dispatch?.parentRunId === id);
    expect(child?.workflow).toBe('quick-task');
  }, 70_000);

  it('if branches on a node output and on the diff', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'measure', type: 'check', command: 'echo 42' },
        { id: 'big', type: 'if', condition: { kind: 'output', ref: 'measure.output', op: '>', value: 10 } },
        { id: 'touch', type: 'check', command: 'mkdir -p web && echo x > web/new.ts' },
        { id: 'web', type: 'if', condition: { kind: 'paths-changed', glob: 'web/**' } },
        { id: 'lines', type: 'if', condition: { kind: 'diff-files', op: '>=', value: 1 } },
        { id: 'yes', type: 'check', command: 'echo yes > if.txt' },
        { id: 'no', type: 'check', command: 'echo no > if.txt' },
      ],
      edges: [
        { from: 'start', to: 'measure' },
        { from: 'measure', to: 'big' },
        { from: 'big.true', to: 'touch' },
        { from: 'big.false', to: 'no' },
        { from: 'touch', to: 'web' },
        { from: 'web.true', to: 'lines' },
        { from: 'web.false', to: 'no' },
        { from: 'lines.true', to: 'yes' },
        { from: 'lines.false', to: 'no' },
      ],
    };
    const id = manager.startRun(def(graph), { task: 'x', worktree: true }).id;
    const final = await until(id, terminal, 30_000);
    const wt = final.worktreePath as string;
    expect(readFileSync(join(wt, 'if.txt'), 'utf8').trim()).toBe('yes');
    expect(final.graphState?.outputs?.web).toMatchObject({ result: 'true', value: 'web/new.ts' });
  }, 40_000);

  it('git.sync-base leaves a real conflict in progress and exits by conflict, with the files', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'mine', type: 'check', command: `echo task > a.txt && git ${GIT_ID.join(' ')} commit -qam task` },
        { id: 'theirs', type: 'check', command: `cd "${repoRoot}" && echo main > a.txt && git ${GIT_ID.join(' ')} commit -qam main` },
        { id: 'sync', type: 'git.sync-base' },
        { id: 'record', type: 'check', command: 'echo "{{nodes.sync.conflicts}}" > conflicts.txt && git status --porcelain | grep "^UU" > unmerged.txt' },
      ],
      edges: [
        { from: 'start', to: 'mine' },
        { from: 'mine', to: 'theirs' },
        { from: 'theirs', to: 'sync' },
        { from: 'sync.conflict', to: 'record' },
      ],
    };
    const final = await until(manager.startRun(def(graph), { task: 'x', worktree: true }).id, terminal, 30_000);
    const wt = final.worktreePath as string;
    expect(readFileSync(join(wt, 'conflicts.txt'), 'utf8').trim()).toBe('a.txt');
    expect(readFileSync(join(wt, 'unmerged.txt'), 'utf8')).toContain('a.txt');
  }, 40_000);

  it('push, PR update and issue comment run faked under CEZ_DRY_RUN', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'push', type: 'git.push' },
        { id: 'pr', type: 'github.draft-pr' },
        { id: 'update', type: 'github.pr-update', ready: true, addLabels: ['cezar'], reviewers: ['octocat'] },
        { id: 'issue', type: 'github.issue-comment', issue: 7, body: 'Fixed in {{nodes.pr.url}}' },
        { id: 'ok', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'push' },
        { from: 'push', to: 'pr' },
        { from: 'pr.created', to: 'update' },
        { from: 'update', to: 'issue' },
        { from: 'issue', to: 'ok' },
      ],
    };
    const final = await until(manager.startRun(def(graph), { task: 'x', worktree: true }).id, terminal, 30_000);
    expect(final.steps.map((st) => [st.id, st.status])).toEqual([
      ['push', 'done'],
      ['pr', 'done'],
      ['update', 'done'],
      ['issue', 'done'],
    ]);
    expect(final.graphState?.outputs?.issue).toEqual({ issue: 7 });
  }, 40_000);

  it('notify.webhook refuses without CEZ_WORKFLOW_WEBHOOKS=1, and runs (dry) with it', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'hook', type: 'notify.webhook', url: 'https://example.invalid/hook', body: 'done: {{task}}' },
        { id: 'sent', type: 'check', command: 'echo sent > hook.txt' },
        { id: 'off', type: 'check', command: 'echo off > hook.txt' },
      ],
      edges: [
        { from: 'start', to: 'hook' },
        { from: 'hook.done', to: 'sent' },
        { from: 'hook.failed', to: 'off' },
      ],
    };
    const saved = process.env.CEZ_WORKFLOW_WEBHOOKS;
    try {
      delete process.env.CEZ_WORKFLOW_WEBHOOKS;
      await until(manager.startRun(def(graph), { task: 'x', worktree: false }).id, terminal);
      expect(readFileSync(join(repoRoot, 'hook.txt'), 'utf8').trim()).toBe('off');
      process.env.CEZ_WORKFLOW_WEBHOOKS = '1';
      await until(manager.startRun(def(graph), { task: 'x', worktree: false }).id, terminal);
      expect(readFileSync(join(repoRoot, 'hook.txt'), 'utf8').trim()).toBe('sent');
    } finally {
      if (saved === undefined) delete process.env.CEZ_WORKFLOW_WEBHOOKS;
      else process.env.CEZ_WORKFLOW_WEBHOOKS = saved;
    }
  }, 40_000);
});
