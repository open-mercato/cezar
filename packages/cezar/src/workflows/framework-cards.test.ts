import { execFile, type SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateCardBody } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// Real bash checks without the developer's login profile (same as graph-system-nodes.test.ts).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options?: SpawnOptions) => actual.spawn(
      file,
      file === 'bash' && args[0] === '-lc' ? ['--noprofile', '--norc', ...args] : args,
      options ?? {},
    ),
  };
});

const sh = promisify(execFile);
const CHANGE_ID = '2026-11-23-tax-rules';

/** A vendored stand-in for `.ai/sdd/sdd.mjs`: status, gate and approve read the one change.json. */
const SDD_FIXTURE = `import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
const [cmd, stage] = process.argv.slice(2);
const dir = '.ai/specs';
const change = readdirSync(dir).find((d) => existsSync(dir + '/' + d + '/change.json'));
const file = dir + '/' + change + '/change.json';
const state = JSON.parse(readFileSync(file, 'utf8'));
if (cmd === 'status') {
  console.log(JSON.stringify({ id: state.id, stages: Object.fromEntries(Object.entries(state.stages).map(([k, v]) => [k, { status: v }])) }));
  process.exit(0);
}
if (cmd === 'gate') {
  const blocker = state.blockers && state.blockers[stage];
  if (blocker) { console.log('blocker: ' + blocker); process.exit(1); }
  process.exit(0);
}
if (cmd === 'approve') {
  if (process.env.SDD_NONINTERACTIVE_APPROVAL !== state.id) { console.error('approve needs a TTY'); process.exit(2); }
  if (state.refuse) { console.error(state.refuse); process.exit(3); }
  state.stages[stage] = 'approved';
  state.approvedBy = process.argv[process.argv.indexOf('--by') + 1];
  writeFileSync(file, JSON.stringify(state, null, 2));
  console.log('approved ' + stage);
  process.exit(0);
}
process.exit(9);
`;

const FRAMEWORKS: Record<string, string> = {
  tsdd: `id: tsdd
name: Test SDD
state:
  command: node .ai/sdd/sdd.mjs status --json
  watch: .ai/specs/*/change.json
stages:
  - id: spec
    precheck: node .ai/sdd/sdd.mjs gate spec
    gate: { kind: framework, approve: spec }
  - id: build
`,
  twip: `id: twip
name: Test WIP
stages:
  - id: plan
  - id: build
    wip: 1
    gate: { kind: approve }
  - id: ship
`,
  tconv: `id: tconv
name: Test conversation
stages:
  - id: talk
    mode: conversation
  - id: after
`,
  texit: `id: texit
name: Test exit
stages:
  - id: write
    artifacts: [ 'docs/*-{{card.slug}}.md' ]
  - id: never
cardFields:
  - { name: slug, label: Slug, from: title }
`,
  ttwo: `id: ttwo
name: Test two
stages:
  - id: a
  - id: b
`,
  // The base commit carries sdd.mjs but not CONVENTIONS.md.
  treq: `id: treq
name: Test requires
requires: [ .ai/sdd/sdd.mjs, .ai/sdd/CONVENTIONS.md ]
stages:
  - id: discover
  - id: build
`,
  // A state watch whose directory does not exist: no fs watcher can be armed.
  tnowatch: `id: tnowatch
name: Test no watch
state:
  command: node .ai/sdd/sdd.mjs status --json
  watch: .ai/nowhere/*/change.json
stages:
  - id: spec
    gate: { kind: framework, approve: spec }
  - id: build
`,
};

describe('framework cards (spec 2026-11-15-framework-board, engine)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;

  const changeFile = (root: string) => join(root, '.ai/specs', CHANGE_ID, 'change.json');
  const writeChange = (root: string, change: Record<string, unknown>) =>
    writeFileSync(changeFile(root), JSON.stringify({ id: CHANGE_ID, ...change }, null, 2));

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-cards-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await sh('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await sh('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
    await sh('git', ['config', 'user.email', 'test@local'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/cezar/\n');
    mkdirSync(join(repoRoot, '.ai/sdd'), { recursive: true });
    mkdirSync(join(repoRoot, '.ai/specs', CHANGE_ID), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/sdd/sdd.mjs'), SDD_FIXTURE);
    writeChange(repoRoot, { stages: { spec: 'pending', build: 'pending' } });
    await sh('git', ['add', '-A'], { cwd: repoRoot });
    await sh('git', ['commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/frameworks'), { recursive: true });
    for (const [id, yaml] of Object.entries(FRAMEWORKS)) writeFileSync(join(repoRoot, '.ai/cezar/frameworks', `${id}.yaml`), yaml);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function until(id: string, pred: (r: RunRecord) => boolean, ms = 25_000): Promise<RunRecord> {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = store.getRun(id);
      if (r && pred(r)) return r;
      if (Date.now() > deadline) {
        throw new Error(`timed out; status=${r?.status} card=${JSON.stringify(r?.card)} steps=${JSON.stringify(r?.steps.map((s) => [s.id, s.status]))}`);
      }
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  const terminal = (r: RunRecord) => ['done', 'review', 'failed', 'cancelled'].includes(r.status);
  const parkedAt = (node: string) => (r: RunRecord) => r.status === 'waiting' && r.steps.find((s) => s.id === node)?.status === 'waiting';
  const card = (body: Partial<CreateCardBody> & { framework: string }) =>
    // `mock:done` lets the last stage (the run's interactive tail) close by itself.
    manager.createCard({ title: 'Tax rules', brief: 'mock:done', ready: true, ...body });
  const restart = async () => {
    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
  };

  describe('scheduler', () => {
    it('a Backlog card never starts; Ready starts it', async () => {
      const held = await card({ framework: 'ttwo', ready: false });
      expect(held.card).toMatchObject({ held: true, stage: 'a', stageOrder: ['a', 'b'] });
      await new Promise((res) => setTimeout(res, 1_500));
      expect(store.getRun(held.id)).toMatchObject({ status: 'queued' });
      expect(store.getRun(held.id)?.startedAt).toBeUndefined();
      expect(await manager.startNow(held.id)).toBe('not-queued');

      manager.patchCard(held.id, { held: false });
      const final = await until(held.id, terminal);
      expect(final.status).not.toBe('failed');
      expect(final.card?.stages).toEqual({ a: 'done', b: 'done' });
      expect(final.card?.history?.map((h) => h.text)).toEqual(expect.arrayContaining(['moved to Ready', 'moved to b']));
    }, 40_000);

    it('queued cards start in Ready order', async () => {
      manager.dispose();
      manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'hold the slot mock:pause mock:done', worktree: true }).id;
      const first = await card({ framework: 'ttwo', title: 'first' });
      const second = await card({ framework: 'ttwo', title: 'second' });
      manager.patchCard(second.id, { order: 0 });
      const [a, b] = await Promise.all([until(first.id, terminal, 60_000), until(second.id, terminal, 60_000)]);
      await until(blocker, terminal);
      expect(Date.parse(b.startedAt!)).toBeLessThan(Date.parse(a.startedAt!));
    }, 90_000);
  });

  it('D9: the approval variable is absent from a check node environment', async () => {
    vi.stubEnv('SDD_NONINTERACTIVE_APPROVAL', CHANGE_ID);
    const graph: WorkflowGraph = {
      nodes: [{ id: 'start', type: 'start' }, { id: 'env', type: 'check', command: 'printf "%s" "${SDD_NONINTERACTIVE_APPROVAL:-absent}" > env.txt' }],
      edges: [{ from: 'start', to: 'env' }],
    };
    const id = manager.startRun({ name: 'env', source: 'file', steps: graphToSteps(graph), graph }, { task: 'x', worktree: false }).id;
    expect((await until(id, terminal)).status).not.toBe('failed');
    expect(readFileSync(join(repoRoot, 'env.txt'), 'utf8')).toBe('absent');
  }, 30_000);

  it('stage.exit fails the run naming the missing glob', async () => {
    const created = await card({ framework: 'texit', title: 'Release notes' });
    const final = await until(created.id, terminal);
    expect(final.status).toBe('failed');
    expect(final.error).toContain('docs/*-release-notes.md');
    expect(final.steps.find((s) => s.id === 'write-exit')?.error).toContain('docs/*-release-notes.md');
    expect(final.steps.find((s) => s.id === 'never-agent')?.status).toBe('pending');
    expect(final.card?.stages.write).toBe('failed');
  }, 40_000);

  describe('framework state (SDD)', () => {
    it('a stage whose precheck exits non-zero never starts, until the blocker clears', async () => {
      writeChange(repoRoot, { stages: { spec: 'pending', build: 'pending' }, blockers: { spec: 'brief.md is not confirmed' } });
      await sh('git', ['commit', '-q', '-am', 'blocked'], { cwd: repoRoot });
      const created = await card({ framework: 'tsdd' });
      const blocked = await until(created.id, parkedAt('spec-enter'));
      expect(blocked.card?.blocked).toMatchObject({ reason: 'precheck' });
      expect(blocked.card?.blocked?.detail).toContain('brief.md is not confirmed');
      const agent = blocked.steps.find((s) => s.id === 'spec-agent');
      expect(agent?.status).toBe('pending');
      expect(agent?.sessionId).toBeUndefined();

      writeChange(blocked.worktreePath!, { stages: { spec: 'pending', build: 'pending' } });
      await manager.recheckFrameworkState();
      const atGate = await until(created.id, parkedAt('spec-gate'));
      expect(atGate.steps.find((s) => s.id === 'spec-agent')?.status).toBe('done');
      manager.cancel(created.id);
    }, 40_000);

    it('the gate advances only when the framework reports approved — never on stale, never on the agent', async () => {
      const created = await card({ framework: 'tsdd' });
      const atGate = await until(created.id, parkedAt('spec-gate'));
      // The agent finished its turn; that alone never opens the gate.
      expect(atGate.steps.find((s) => s.id === 'spec-agent')?.status).toBe('done');
      expect(atGate.card).toMatchObject({ stage: 'spec', blocked: { reason: 'gate' }, frameworkState: { changeId: CHANGE_ID } });
      expect(atGate.card?.stages.spec).toBe('waiting');
      // The cockpit reads which gate holds the card off the record, cleared once it leaves.
      expect(atGate.card?.gate).toEqual({ kind: 'framework', approve: 'spec' });
      expect(atGate.card?.frameworkStateDef).toEqual({ command: 'node .ai/sdd/sdd.mjs status --json', watch: '.ai/specs/*/change.json' });
      const wt = atGate.worktreePath!;

      writeChange(wt, { stages: { spec: 'stale', build: 'pending' } });
      await manager.recheckFrameworkState(created.id);
      const stale = store.getRun(created.id)!;
      expect(stale.status).toBe('waiting');
      expect(stale.card?.stages.spec).toBe('stale');
      expect(stale.steps.find((s) => s.id === 'build-agent')?.status).toBe('pending');

      writeChange(wt, { stages: { spec: 'approved', build: 'pending' } });
      await manager.recheckFrameworkState(created.id);
      const final = await until(created.id, terminal);
      expect(final.status).not.toBe('failed');
      expect(final.steps.find((s) => s.id === 'build-agent')?.status).toBe('done');
      expect(final.card?.blocked).toBeUndefined();
      expect(final.card?.gate).toBeUndefined();
    }, 40_000);

    it('the state watcher advances a parked gate on its own, and closes with the park', async () => {
      const created = await card({ framework: 'tsdd' });
      const atGate = await until(created.id, parkedAt('spec-gate'));
      expect(manager.activeFrameworkWatchers()).toBe(1);
      writeChange(atGate.worktreePath!, { stages: { spec: 'approved', build: 'pending' } });
      await until(created.id, terminal);
      expect(manager.activeFrameworkWatchers()).toBe(0);
    }, 40_000);

    it('D9: Approve runs the script with the approval variable and commits change.json', async () => {
      const created = await card({ framework: 'tsdd' });
      const atGate = await until(created.id, parkedAt('spec-gate'));
      expect(await manager.approveCardGate(created.id, 'Ada')).toEqual({ ok: true });
      const final = await until(created.id, terminal);
      expect(final.status).not.toBe('failed');
      expect(final.card?.history?.map((h) => h.text)).toContain('spec approved by Ada in cezar (non-interactive)');
      const wt = atGate.worktreePath!;
      expect(JSON.parse(readFileSync(changeFile(wt), 'utf8'))).toMatchObject({ approvedBy: 'Ada', stages: { spec: 'approved' } });
      const { stdout } = await sh('git', ['log', '--format=%s', '-n', '20'], { cwd: wt });
      expect(stdout).toContain(`sdd: approve spec for ${CHANGE_ID}`);
    }, 40_000);

    it('D9: a refused approve leaves the card parked with the script message', async () => {
      writeChange(repoRoot, { stages: { spec: 'pending', build: 'pending' }, refuse: 'spec.md has 2 open questions' });
      await sh('git', ['commit', '-q', '-am', 'refuse'], { cwd: repoRoot });
      const created = await card({ framework: 'tsdd' });
      await until(created.id, parkedAt('spec-gate'));
      const result = await manager.approveCardGate(created.id, 'Ada');
      expect(result).toMatchObject({ ok: false });
      expect(!result.ok && result.error).toContain('2 open questions');
      const still = store.getRun(created.id)!;
      expect(still.status).toBe('waiting');
      expect(still.card?.blocked?.reason).toBe('gate');
      manager.cancel(created.id);
    }, 40_000);

    it('a card parked at a framework gate survives a restart', async () => {
      const created = await card({ framework: 'tsdd' });
      const atGate = await until(created.id, parkedAt('spec-gate'));
      await restart();
      const back = await until(created.id, parkedAt('spec-gate'));
      expect(back.steps.find((s) => s.id === 'spec-agent')?.iterations).toBe(1);
      expect(back.card?.blocked?.reason).toBe('gate');
      writeChange(atGate.worktreePath!, { stages: { spec: 'approved', build: 'pending' } });
      await manager.recheckFrameworkState();
      expect((await until(created.id, terminal)).status).not.toBe('failed');
    }, 60_000);
  });

  describe('conversation stages (D10)', () => {
    it('parks after every turn without a slot; STAGE-DONE + Not yet stays; Finish stage moves on', async () => {
      manager.dispose();
      manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
      const created = await card({ framework: 'tconv' });
      const parked = await until(created.id, parkedAt('talk-agent'));
      expect(parked.askParked).toBeUndefined();
      expect(parked.card?.stages.talk).toBe('waiting');
      expect(parked.card?.conversation).toBe(true);
      const session = parked.steps.find((s) => s.id === 'talk-agent')?.sessionId;
      // Holds no slot: another task runs to the end meanwhile under maxParallel 1.
      const other = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'meanwhile mock:done', worktree: true }).id;
      expect(terminal(await until(other, terminal))).toBe(true);

      expect(manager.sendMessage(created.id, [{ type: 'text', text: 'tell me more' }])).toBe(true);
      await until(created.id, (r) => r.status === 'running');
      await until(created.id, parkedAt('talk-agent'));
      expect(manager.sendMessage(created.id, [{ type: 'text', text: 'that is all mock:stage-done' }])).toBe(true);
      const proposed = await until(created.id, (r) => parkedAt('talk-agent')(r) && r.askParked === true);
      expect(proposed.steps.find((s) => s.id === 'talk-agent')?.sessionId).toBe(session);
      const events = readFileSync(join(repoRoot, '.ai/cezar/runs', `${created.id}.ndjson`), 'utf8');
      expect(events).toContain('Finish this stage?');

      expect(manager.sendMessage(created.id, [{ type: 'text', text: 'Finish stage: Not yet' }])).toBe(true);
      const stays = await until(created.id, (r) => parkedAt('talk-agent')(r) && r.askParked === undefined);
      expect(stays.steps.find((s) => s.id === 'after-agent')?.status).toBe('pending');

      manager.finishStage(created.id);
      const final = await until(created.id, terminal);
      expect(final.status).not.toBe('failed');
      expect(final.steps.find((s) => s.id === 'talk-agent')?.status).toBe('done');
      expect(final.steps.find((s) => s.id === 'after-agent')?.status).toBe('done');
      expect(final.card?.stages.talk).toBe('done');
      expect(final.card?.conversation).toBeUndefined();
    }, 60_000);

    it('STAGE-DONE + Yes finishes the stage', async () => {
      const created = await card({ framework: 'tconv', brief: 'mock:stage-done' });
      await until(created.id, (r) => parkedAt('talk-agent')(r) && r.askParked === true);
      manager.sendMessage(created.id, [{ type: 'text', text: 'Finish stage: Yes' }]);
      // The brief's marker rides into the last stage too, so its interactive tail is closed by hand.
      await until(created.id, parkedAt('after-agent'));
      manager.finish(created.id);
      const final = await until(created.id, terminal);
      expect(final.steps.find((s) => s.id === 'after-agent')?.status).toBe('done');
    }, 40_000);

    it('Let the agent decide takes one unattended turn, then moves on', async () => {
      const created = await card({ framework: 'tconv' });
      await until(created.id, parkedAt('talk-agent'));
      manager.patchCard(created.id, { autonomous: true });
      const final = await until(created.id, terminal);
      expect(final.steps.find((s) => s.id === 'after-agent')?.status).toBe('done');
      expect(final.card?.autonomous).toBe(true);
    }, 40_000);

    it('a card parked in a conversation stage survives a restart without a new turn', async () => {
      const created = await card({ framework: 'tconv' });
      const parked = await until(created.id, parkedAt('talk-agent'));
      const session = parked.steps.find((s) => s.id === 'talk-agent')?.sessionId;
      await restart();
      const back = await until(created.id, parkedAt('talk-agent'));
      expect(back.steps.find((s) => s.id === 'talk-agent')?.sessionId).toBe(session);
      const turns = () => readFileSync(join(repoRoot, '.ai/cezar/runs', `${created.id}.ndjson`), 'utf8').split('\n').filter((l) => l.includes('"type":"turn-end"')).length;
      const before = turns();
      await new Promise((res) => setTimeout(res, 1_000));
      expect(turns()).toBe(before);
      manager.sendMessage(created.id, [{ type: 'text', text: 'continue please' }]);
      await until(created.id, (r) => r.status === 'running');
      await until(created.id, parkedAt('talk-agent'));
      manager.finishStage(created.id);
      expect((await until(created.id, terminal)).status).not.toBe('failed');
    }, 60_000);
  });

  describe('WIP (D13)', () => {
    /** Card A holds build (parked at its approve gate); card B waits at build-enter. */
    async function fullStage() {
      const a = await card({ framework: 'twip', title: 'first' });
      expect((await until(a.id, parkedAt('build-gate'))).card?.gate).toEqual({ kind: 'approve' });
      const b = await card({ framework: 'twip', title: 'second' });
      const blocked = await until(b.id, parkedAt('build-enter'));
      expect(blocked.card?.blocked).toMatchObject({ reason: 'wip', detail: '1/1 cards in this stage' });
      expect(blocked.steps.find((s) => s.id === 'build-agent')?.status).toBe('pending');
      return { a: a.id, b: b.id };
    }
    const admitted = (id: string) => until(id, parkedAt('build-gate'));

    it('wakes when the holder advances', async () => {
      const { a, b } = await fullStage();
      manager.sendMessage(a, [{ type: 'text', text: 'Approve' }]);
      await admitted(b);
      expect(store.getRun(b)?.card?.blocked).toBeUndefined();
      manager.cancel(b);
    }, 60_000);

    it('wakes when the holder is cancelled', async () => {
      const { a, b } = await fullStage();
      manager.cancel(a);
      await admitted(b);
      manager.cancel(b);
    }, 60_000);

    it('wakes when the holder is re-run from an earlier stage, which then waits its turn', async () => {
      const { a, b } = await fullStage();
      const rerun = await manager.rerunCard(a, 'plan');
      expect(rerun.card).toMatchObject({ stage: 'plan', stages: { plan: 'pending', build: 'pending' } });
      await admitted(b);
      const back = await until(a, parkedAt('build-enter'));
      expect(back.card?.blocked?.reason).toBe('wip');
      manager.cancel(b);
      await admitted(a);
      manager.cancel(a);
    }, 90_000);

    /** A holder this manager is not running (a record) — the fail and delete paths. */
    function recordHolder(status: RunRecord['status']): string {
      const { id } = store.createRun({ title: 'holder', workflow: 'framework:twip', task: 'holder', steps: [] });
      const live = store.getRun(id);
      expect(live).toBeDefined();
      store.updateRun(id, {
        status,
        graphState: { loops: {}, taken: [], cursor: 'build-gate' },
        card: { framework: 'twip', frameworkHash: 'x', title: 'holder', stage: 'build', stages: { plan: 'done', build: 'waiting', ship: 'pending' }, stageOrder: ['plan', 'build', 'ship'], order: 0 },
      });
      return id;
    }

    it('wakes when the holder fails', async () => {
      const holder = recordHolder('waiting');
      const b = await card({ framework: 'twip', title: 'second' });
      await until(b.id, parkedAt('build-enter'));
      store.updateRun(holder, { status: 'failed', finishedAt: new Date().toISOString() });
      await admitted(b.id);
      manager.cancel(b.id);
    }, 60_000);

    it('wakes when the holder is deleted', async () => {
      const holder = recordHolder('waiting');
      const b = await card({ framework: 'twip', title: 'second' });
      await until(b.id, parkedAt('build-enter'));
      store.deleteRun(holder);
      await admitted(b.id);
      manager.cancel(b.id);
    }, 60_000);

    it('survives a restart, and re-evaluates at boot', async () => {
      const { a, b } = await fullStage();
      await restart();
      // Both come back where they were: A at its gate, B still waiting for the place.
      await until(a, parkedAt('build-gate'));
      const still = await until(b, parkedAt('build-enter'));
      expect(still.card?.blocked?.reason).toBe('wip');
      // The holder goes away while cezar is down: the boot evaluation admits B.
      manager.dispose();
      store.flush();
      store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
      store.updateRun(a, { status: 'cancelled', finishedAt: new Date().toISOString() });
      manager = new RunManager(store, repoRoot);
      await manager.recover();
      await admitted(b);
      manager.cancel(b);
    }, 90_000);
  });
  describe('required framework files (requires)', () => {
    const conventions = (root: string) => join(root, '.ai/sdd/CONVENTIONS.md');

    it('a card is refused when the ref it forks from lacks them — even if the checkout has them uncommitted', async () => {
      await expect(card({ framework: 'treq' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/Test requires is not installed on main — cards fork from main.*missing: \.ai\/sdd\/CONVENTIONS\.md/),
      });
      writeFileSync(conventions(repoRoot), '# conventions\n');
      await expect(card({ framework: 'treq' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('present in the checkout but not committed on main'),
      });
      expect(store.listRuns()).toHaveLength(0);

      await sh('git', ['add', '-A'], { cwd: repoRoot });
      await sh('git', ['commit', '-q', '-m', 'conventions'], { cwd: repoRoot });
      const created = await card({ framework: 'treq' });
      expect(created.card?.requires).toEqual(['.ai/sdd/sdd.mjs', '.ai/sdd/CONVENTIONS.md']);
      expect((await until(created.id, terminal)).status).not.toBe('failed');
    }, 40_000);

    it('an in-flight card whose branch lacks them parks at the stage entry until they arrive', async () => {
      manager.dispose();
      manager = new RunManager(store, repoRoot, { frameworkRecheckBackoffMs: { initial: 200, max: 400 } });
      writeFileSync(conventions(repoRoot), '# conventions\n');
      await sh('git', ['add', '-A'], { cwd: repoRoot });
      await sh('git', ['commit', '-q', '-m', 'conventions'], { cwd: repoRoot });
      const held = await card({ framework: 'treq', ready: false });
      // Removed from the base after creation: the worktree forks without it.
      await sh('git', ['rm', '-q', '.ai/sdd/CONVENTIONS.md'], { cwd: repoRoot });
      await sh('git', ['commit', '-q', '-m', 'drop conventions'], { cwd: repoRoot });
      manager.patchCard(held.id, { held: false });

      const blocked = await until(held.id, parkedAt('discover-enter'));
      expect(blocked.card?.blocked).toMatchObject({ reason: 'precheck' });
      expect(blocked.card?.blocked?.detail).toContain('.ai/sdd/CONVENTIONS.md');
      expect(blocked.card?.blocked?.detail).toContain('merge or rebase main into this card');
      const agent = blocked.steps.find((st) => st.id === 'discover-agent');
      expect(agent?.status).toBe('pending');
      expect(agent?.sessionId).toBeUndefined();
      expect(manager.activeFrameworkBackoffs()).toBe(1);

      // The backoff recheck sees the file land in the card's own worktree.
      writeFileSync(conventions(blocked.worktreePath!), '# conventions\n');
      const final = await until(held.id, terminal);
      expect(final.status).not.toBe('failed');
      expect(final.card?.blocked).toBeUndefined();
      expect(manager.activeFrameworkBackoffs()).toBe(0);
    }, 40_000);
  });

  describe('review fixes', () => {
    /** A card record this manager is not running, queued with whatever walk state the case needs. */
    function queuedCardRecord(card: Partial<NonNullable<RunRecord['card']>>, cursor?: string): string {
      const { id } = store.createRun({ title: 'mid-walk', workflow: 'framework:ttwo', task: 'mid-walk', steps: [] });
      store.updateRun(id, {
        status: 'queued',
        ...(cursor ? { graphState: { loops: {}, taken: [], cursor } } : {}),
        card: { framework: 'ttwo', frameworkHash: 'x', title: 'mid-walk', stage: 'b', stages: { a: 'done', b: 'pending' }, stageOrder: ['a', 'b'], order: 0, ...card },
      });
      return id;
    }

    it('a card re-queued mid-walk neither moves to the Backlog nor recompiles its content', () => {
      const ready = queuedCardRecord({}, 'b-agent');
      expect(() => manager.patchCard(ready, { held: true })).toThrow(/has not started/);
      expect(store.getRun(ready)?.card?.held).toBeUndefined();
      const held = queuedCardRecord({ held: true }, 'b-agent');
      expect(() => manager.patchCard(held, { title: 'renamed' })).toThrow(/only while the card is in the Backlog/);
      expect(store.getRun(held)?.card?.title).toBe('mid-walk');
      // Guard: a card that never started still edits and moves freely.
      const fresh = queuedCardRecord({ held: true });
      expect(manager.patchCard(fresh, { title: 'renamed', held: true }).card?.title).toBe('renamed');
    });

    it('a Backlog card is not a running task (self-update) and cannot be run first', async () => {
      const semaphore = new WorkspaceSemaphore();
      manager.dispose();
      manager = new RunManager(store, repoRoot, { semaphore });
      const held = await card({ framework: 'ttwo', ready: false });
      expect(store.getRun(held.id)?.status).toBe('queued');
      expect(semaphore.activeRuns()).toBe(0);
      expect(manager.promote(held.id)).toBe(false);
      manager.patchCard(held.id, { held: false });
      await until(held.id, terminal);
    }, 40_000);

    describe('an automatic release goes through the queue; a person continues in place', () => {
      async function parkedWithSlotTaken() {
        manager.dispose();
        manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
        const created = await card({ framework: 'tsdd' });
        const atGate = await until(created.id, parkedAt('spec-gate'));
        const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'hold the slot mock:slow mock:done', worktree: true }).id;
        await until(blocker, (r) => r.status === 'running');
        return { id: created.id, wt: atGate.worktreePath!, blocker };
      }

      it('the framework state releasing a gate queues the card for a slot', async () => {
        const { id, wt, blocker } = await parkedWithSlotTaken();
        writeChange(wt, { stages: { spec: 'approved', build: 'pending' } });
        await manager.recheckFrameworkState(id);
        const queued = await until(id, (r) => r.status === 'queued');
        expect(queued.card?.gate).toBeUndefined();
        await new Promise((res) => setTimeout(res, 1_500));
        const still = store.getRun(id)!;
        expect(still.status).toBe('queued');
        expect(still.steps.find((st) => st.id === 'build-agent')?.status).toBe('pending');
        manager.cancel(blocker);
        const final = await until(id, terminal);
        expect(final.status).not.toBe('failed');
        expect(final.steps.find((st) => st.id === 'build-agent')?.status).toBe('done');
        expect(final.card?.history?.map((h) => h.text)).toContain('spec approved (framework state)');
      }, 60_000);

      it('an in-cockpit approve continues in place (#347)', async () => {
        const { id, blocker } = await parkedWithSlotTaken();
        expect(await manager.approveCardGate(id, 'Ada')).toEqual({ ok: true });
        await until(id, (r) => r.steps.find((st) => st.id === 'build-agent')?.status !== 'pending');
        expect(store.getRun(blocker)?.status).toBe('running');
        manager.cancel(blocker);
        manager.cancel(id);
      }, 60_000);
    });

    describe('a park no watcher covers gets a bounded backoff recheck', () => {
      beforeEach(() => {
        manager.dispose();
        manager = new RunManager(store, repoRoot, { frameworkRecheckBackoffMs: { initial: 200, max: 400 } });
      });

      it('advances on its own, and the timer goes with the park', async () => {
        const created = await card({ framework: 'tnowatch' });
        const atGate = await until(created.id, parkedAt('spec-gate'));
        expect(manager.activeFrameworkWatchers()).toBe(0);
        expect(manager.activeFrameworkBackoffs()).toBe(1);
        writeChange(atGate.worktreePath!, { stages: { spec: 'approved', build: 'pending' } });
        expect((await until(created.id, terminal)).status).not.toBe('failed');
        expect(manager.activeFrameworkBackoffs()).toBe(0);
      }, 40_000);

      it('is cleared on cancel and on dispose', async () => {
        const created = await card({ framework: 'tnowatch' });
        await until(created.id, parkedAt('spec-gate'));
        expect(manager.activeFrameworkBackoffs()).toBe(1);
        manager.cancel(created.id);
        await until(created.id, terminal);
        expect(manager.activeFrameworkBackoffs()).toBe(0);

        const again = await card({ framework: 'tnowatch' });
        await until(again.id, parkedAt('spec-gate'));
        expect(manager.activeFrameworkBackoffs()).toBe(1);
        manager.dispose();
        expect(manager.activeFrameworkBackoffs()).toBe(0);
      }, 40_000);
    });

    it('D3: a parked card reads its own state snapshot, so a deleted framework file cannot strand it', async () => {
      const created = await card({ framework: 'tsdd' });
      const atGate = await until(created.id, parkedAt('spec-gate'));
      rmSync(join(repoRoot, '.ai/cezar/frameworks/tsdd.yaml'));
      writeChange(atGate.worktreePath!, { stages: { spec: 'approved', build: 'pending' } });
      await manager.recheckFrameworkState(created.id);
      expect((await until(created.id, terminal)).status).not.toBe('failed');
    }, 40_000);

    it('a stage place released by a cancelled admission wakes the next card', async () => {
      const hold = join(repoRoot, 'hold');
      writeFileSync(hold, '');
      writeFileSync(join(repoRoot, '.ai/cezar/frameworks/tadmit.yaml'), `id: tadmit
name: Test admit
stages:
  - id: plan
  - id: build
    wip: 1
    precheck: while [ -f '${hold}' ]; do sleep 0.1; done
  - id: ship
`);
      const a = await card({ framework: 'tadmit', title: 'first' });
      // A was admitted (holds the place) and is still in its precheck.
      await until(a.id, (r) => r.card?.stage === 'build' && r.steps.find((st) => st.id === 'build-enter')?.status === 'running');
      const b = await card({ framework: 'tadmit', title: 'second' });
      expect((await until(b.id, parkedAt('build-enter'))).card?.blocked?.reason).toBe('wip');
      manager.cancel(a.id);
      rmSync(hold);
      expect((await until(a.id, terminal)).status).toBe('cancelled');
      await until(b.id, (r) => r.steps.find((st) => st.id === 'build-agent')?.status !== 'pending', 15_000);
      manager.cancel(b.id);
    }, 60_000);

    it('a pending "Finish this stage?" survives a restart, and Yes still finishes the stage', async () => {
      const created = await card({ framework: 'tconv', brief: 'mock:stage-done' });
      await until(created.id, (r) => parkedAt('talk-agent')(r) && r.askParked === true);
      await restart();
      await until(created.id, (r) => parkedAt('talk-agent')(r) && r.askParked === true);
      manager.sendMessage(created.id, [{ type: 'text', text: 'Finish stage: Yes' }]);
      await until(created.id, parkedAt('after-agent'));
      expect(store.getRun(created.id)?.steps.find((st) => st.id === 'talk-agent')?.status).toBe('done');
      manager.finish(created.id);
      await until(created.id, terminal);
    }, 60_000);
  });
  describe('a revived card resumes its graph walk, never a standalone session', () => {
    const events = (id: string) => readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; text?: string; stepId?: string; message?: string });
    const interruptedWhileAsking = async (framework: string, node: string) => {
      const created = await card({ framework, brief: 'mock:ask' });
      await until(created.id, (r) => parkedAt(node)(r) && r.askParked === true);
      await restart();
      return until(created.id, (r) => r.status === 'failed' && r.awaitingAnswerSince !== undefined);
    };

    it('a conversation card interrupted while asking: the answer revives the stage; STAGE-DONE asks "Finish this stage?"', async () => {
      const failed = await interruptedWhileAsking('tconv', 'talk-agent');
      expect(failed.graphState?.cursor).toBe('talk-agent');
      const session = failed.steps.find((s) => s.id === 'talk-agent')?.sessionId;
      expect(manager.continueRun(failed.id, { text: 'Library: date-fns mock:stage-done-dot', reply: {} })).toEqual({ ok: true });
      const proposed = await until(failed.id, (r) => parkedAt('talk-agent')(r) && r.askParked === true);
      expect(proposed.steps.some((s) => s.id.startsWith('continue-'))).toBe(false);
      expect(proposed.steps.find((s) => s.id === 'talk-agent')?.sessionId).toBe(session);
      expect(proposed.awaitingAnswerSince).toBeUndefined();
      expect(proposed.card?.conversation).toBe(true);
      const log = events(failed.id);
      expect(log.some((e) => e.type === 'user-message' && e.stepId === 'talk-agent' && e.text?.includes('date-fns'))).toBe(true);
      expect(JSON.stringify(log)).toContain('Finish this stage?');
      expect(log.filter((e) => e.type === 'text').some((e) => e.text?.includes('CEZ:STAGE-DONE'))).toBe(false);

      manager.sendMessage(failed.id, [{ type: 'text', text: 'Finish stage: Yes' }]);
      const next = await until(failed.id, (r) => r.steps.find((s) => s.id === 'after-enter')?.status === 'done');
      expect(next.steps.find((s) => s.id === 'talk-agent')?.status).toBe('done');
      expect(next.card?.stages.talk).toBe('done');
      manager.cancel(failed.id);
    }, 60_000);

    it('an answer without STAGE-DONE parks the conversation again, holding no slot', async () => {
      const failed = await interruptedWhileAsking('tconv', 'talk-agent');
      manager.dispose();
      manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
      expect(manager.continueRun(failed.id, { text: 'Library: Luxon', reply: {} })).toEqual({ ok: true });
      const parked = await until(failed.id, (r) => parkedAt('talk-agent')(r) && r.graphState?.outputs?.['talk-agent']?.conversation !== undefined);
      expect(parked.askParked).toBeUndefined();
      expect(parked.card?.conversation).toBe(true);
      expect(parked.steps.some((s) => s.id.startsWith('continue-'))).toBe(false);
      const other = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'meanwhile mock:done', worktree: true }).id;
      expect(terminal(await until(other, terminal))).toBe(true);
      manager.finishStage(failed.id);
      await until(failed.id, (r) => r.steps.find((s) => s.id === 'after-enter')?.status === 'done');
      manager.cancel(failed.id);
    }, 60_000);

    it('a failed card: Continue resumes the walk at its cursor, and the walk advances on the node\'s port', async () => {
      const failed = await interruptedWhileAsking('ttwo', 'a-agent');
      expect(failed.graphState?.cursor).toBe('a-agent');
      expect(manager.continueRun(failed.id, { text: 'use date-fns' })).toEqual({ ok: true });
      // `b` carries the brief's question too, so the walk reaching it parks there.
      const next = await until(failed.id, (r) => parkedAt('b-agent')(r) && r.askParked === true);
      expect(next.steps.find((s) => s.id === 'a-agent')?.status).toBe('done');
      expect(next.card?.stages.a).toBe('done');
      expect(next.steps.some((s) => s.id.startsWith('continue-'))).toBe(false);
      manager.cancel(failed.id);
    }, 60_000);

    it('guard: an ad-hoc run keeps the standalone continuation', async () => {
      const id = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'pick one mock:ask', worktree: true }).id;
      await until(id, (r) => r.status === 'waiting' && r.askParked === true);
      await restart();
      await until(id, (r) => r.status === 'failed' && r.awaitingAnswerSince !== undefined);
      expect(manager.continueRun(id, { text: 'date-fns', reply: {} })).toEqual({ ok: true });
      const back = await until(id, (r) => r.status === 'waiting' && r.steps.some((s) => s.id === 'continue-1' && s.status === 'waiting'));
      expect(back.card).toBeUndefined();
      manager.cancel(id);
    }, 60_000);

    it('boot repair: a card stranded as a standalone session at its conversation stage goes back to the walk', async () => {
      // The shape of run 77481ca6: the walk's cursor on the conversation node, and a live
      // `continue-N` session (opened before revivals went through the walk) whose last turn
      // proposed finishing the stage.
      const created = await card({ framework: 'tconv' });
      const parked = await until(created.id, parkedAt('talk-agent'));
      manager.dispose();
      const at = new Date(Date.now() + 1_000).toISOString();
      const outputs = { ...parked.graphState?.outputs };
      delete outputs['talk-agent'];
      store.updateStep(created.id, 'talk-agent', { status: 'failed', error: 'interrupted' });
      store.addStep(created.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
      store.updateStep(created.id, 'continue-1', { status: 'waiting', startedAt: at, sessionId: 'stranded-session', backend: 'claude' });
      store.appendEvent(created.id, { type: 'text', stepId: 'continue-1', text: 'The brief is complete.\n\nCEZ:STAGE-DONE' });
      const { conversation: _c, ...cardRest } = parked.card!;
      store.updateRun(created.id, {
        status: 'waiting', currentStepId: 'continue-1', askParked: undefined,
        graphState: { ...parked.graphState!, cursor: 'talk-agent', outputs },
        card: cardRest,
      });
      store.flush();
      await restart();
      const back = await until(created.id, (r) => parkedAt('talk-agent')(r) && r.askParked === true);
      expect(back.steps.find((s) => s.id === 'talk-agent')?.sessionId).toBe('stranded-session');
      expect(back.steps.find((s) => s.id === 'continue-1')?.status).toBe('done');
      expect(back.card?.conversation).toBe(true);
      manager.sendMessage(created.id, [{ type: 'text', text: 'Finish stage: Yes' }]);
      await until(created.id, (r) => r.steps.find((s) => s.id === 'after-enter')?.status === 'done');
      manager.cancel(created.id);
    }, 60_000);

    it('boot repair also reaches a stranded card whose session the idle timer had already closed', async () => {
      // The shape of run 77481ca6: the walk's cursor on the conversation node, and a live
      // `continue-N` session (opened before revivals went through the walk) whose last turn
      // proposed finishing the stage.
      const created = await card({ framework: 'tconv' });
      const parked = await until(created.id, parkedAt('talk-agent'));
      manager.dispose();
      const at = new Date(Date.now() + 1_000).toISOString();
      const outputs = { ...parked.graphState?.outputs };
      delete outputs['talk-agent'];
      store.updateStep(created.id, 'talk-agent', { status: 'failed', error: 'interrupted' });
      store.addStep(created.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
      store.updateStep(created.id, 'continue-1', { status: 'waiting', startedAt: at, sessionId: 'stranded-session', backend: 'claude' });
      store.appendEvent(created.id, { type: 'text', stepId: 'continue-1', text: 'The brief is complete.\n\nCEZ:STAGE-DONE' });
      const { conversation: _c, ...cardRest } = parked.card!;
      store.updateRun(created.id, {
        status: 'waiting', currentStepId: 'continue-1', askParked: undefined, idleClosedAt: at,
        graphState: { ...parked.graphState!, cursor: 'talk-agent', outputs },
        card: cardRest,
      });
      store.flush();
      await restart();
      const back = await until(created.id, (r) => parkedAt('talk-agent')(r) && r.askParked === true);
      expect(back.steps.find((s) => s.id === 'talk-agent')?.sessionId).toBe('stranded-session');
      expect(back.steps.find((s) => s.id === 'continue-1')?.status).toBe('done');
      expect(back.card?.conversation).toBe(true);
      expect(back.idleClosedAt).toBeUndefined();
      manager.sendMessage(created.id, [{ type: 'text', text: 'Finish stage: Yes' }]);
      await until(created.id, (r) => r.steps.find((s) => s.id === 'after-enter')?.status === 'done');
      manager.cancel(created.id);
    }, 60_000);
  });
});
