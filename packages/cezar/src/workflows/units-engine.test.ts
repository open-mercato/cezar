import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunUnit } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The unit hierarchy's ENGINE (spec `.ai/specs/2026-09-08-units-hierarchy.md`), driven end to end
 * through the dry-run mock: a caesar that delegates, refusals that are notes rather than crashes,
 * the two budget brakes, the cancel cascade, the settle→parent report, and the Guard.
 *
 * Everything here is gated twice — `CEZ_UNITS=1` AND a `unit` on the record — so the last
 * describe block is the counterweight: the same turns on a run with no `unit` must behave exactly
 * as they did before this feature existed.
 *
 * The runs are real: real worktrees off a real temp repository, because the fork point IS the
 * feature (Q3) and a `worktree: false` fixture could not observe it.
 */
describe('the unit engine (spec 2026-09-08-units-hierarchy)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const started: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const SINGLE_STEP: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-units-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_UNITS']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_UNITS = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = boot();
    started.length = 0;
  });

  afterEach(() => {
    for (const id of started) manager.cancel(id);
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A manager with its own semaphore, so a test can decide how much of the tree may run. */
  const boot = (limits: Partial<WorkspaceResourceLimits> = {}): RunManager =>
    new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: limits }) });

  /** Re-boot the manager with different limits (before anything has started). */
  const reboot = (limits: Partial<WorkspaceResourceLimits>): void => {
    manager.dispose();
    manager = boot(limits);
  };

  const start = (task: string, unit?: RunUnit, extra: Record<string, unknown> = {}): RunRecord => {
    const record = manager.startRun(SINGLE_STEP, { task, ...(unit ? { unit } : {}), ...extra });
    started.push(record.id);
    return record;
  };

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time for ${id}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const notes = (id: string): string[] =>
    store
      .readEvents(id)
      .filter((event) => event.type === 'note')
      .map((event) => String((event as { message?: unknown }).message ?? ''));

  const childrenOf = (parentId: string): RunRecord[] =>
    store.listRuns().filter((r) => r.unit?.parentRunId === parentId);

  const settled = (r: RunRecord | undefined): boolean =>
    r !== undefined && ['done', 'review', 'failed', 'cancelled'].includes(r.status);

  /** Everything the mock has been handed on stdin so far — '' before its first session opens. */
  const stdin = (file: string): string => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };

  /** The full inbound message containing `needle` (the scripted replies only echo a slice). */
  const delivered = (file: string, needle: string): string | undefined =>
    stdin(file)
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { userText: string })
      .find((entry) => entry.userText.includes(needle))?.userText;

  const activeState = (id: string) =>
    (manager as unknown as {
      active: Map<string, { monitoringWakeTimer?: NodeJS.Timeout; unitRole?: string }>;
    }).active.get(id);

  const caesar = (missionId: string, budgetUsd?: number): RunUnit => ({
    role: 'caesar',
    missionId,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ladder: { legate: { runner: 'claude', model: 'sonnet' } },
  });

  // ---- delegation ---------------------------------------------------------------------------

  describe('CEZ:SPAWN', () => {
    it('creates one child per order, one rank down, forked off the parent branch, and parks the parent as a monitor', async () => {
      // One slot and no monitoring exemption: the children are CREATED but never dispatched, so
      // the parent's park is observable without racing its own children's reports.
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn take the hill', caesar('m1', 20));
      await waitFor(record.id, (r) => r?.activity === 'monitoring');

      const parent = store.getRun(record.id);
      // Parked exactly like CEZ:MONITORING (spec §Markers): a non-attention state that surrenders
      // the slot to the children, with a wake deadline so the commander can re-check on its own.
      expect(parent?.status).toBe('running');
      expect(parent?.activity).toBe('monitoring');
      expect(parent?.monitoringWakeAt).toBeTruthy();
      expect(activeState(record.id)?.monitoringWakeTimer).toBeDefined();

      const children = childrenOf(record.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.title).sort()).toEqual(['Take the left flank', 'Take the right flank']);
      for (const child of children) {
        expect(child.unit?.role).toBe('legate'); // caesar → legate, never a second caesar
        expect(child.unit?.missionId).toBe('m1');
        expect(child.unit?.parentRunId).toBe(record.id);
        expect(child.unit?.budgetUsd).toBe(2.5); // the order's own max_cost, inside the mission budget
        expect(child.unit?.ladder).toEqual({ legate: { runner: 'claude', model: 'sonnet' } });
        expect(child.autonomous).toBe(true);
        // Q3: the child forks off the PARENT's branch, which is what `execute()` reads.
        expect(child.baseBranch).toBe(parent?.branch);
        expect(child.baseBranch).toMatch(/^cez\//);
        // The task order the child actually receives — its own scope, not a sibling's.
        const flank = child.title.includes('left') ? 'left' : 'right';
        expect(child.task).toContain('## Task order');
        expect(child.task).toContain(`- Scope: src/${flank}/**`);
        expect(child.task).toContain('- Max cost: $2.50');
        expect(child.task).toContain(`- Parent branch (your fork point): ${parent?.branch}`);
        expect(child.task).toContain(`- Ordered by: the caesar on run ${record.id}`);
      }
      // And the commander's transcript says who it delegated to.
      expect(notes(record.id).some((n) => n.startsWith('delegated to 2 units:') && n.includes('(legate,'))).toBe(true);
      // The raw payload never reaches the transcript as prose.
      const texts = store.readEvents(record.id).filter((e) => e.type === 'text');
      expect(texts.some((e) => String((e as { text?: unknown }).text).includes('CEZ:SPAWN'))).toBe(false);
    }, 40_000);

    it('surrenders the commander’s slot to its children even past maxMonitoringSessions', async () => {
      // The starvation shape, at its smallest: ONE slot, ONE monitoring exemption — and that
      // exemption already taken by an ordinary monitor. The commander is then the SECOND
      // monitor, and counting it as busy (`busySlots` capped every monitor at
      // `maxMonitoringSessions`) makes it hold the only slot forever: neither legate is ever
      // dispatched, the commander waits for reports that cannot be produced, and every other
      // project on the shared semaphore waits behind it. Its process is idle — the runs that
      // need the slot are its children.
      reboot({ maxParallel: 1, maxMonitoringSessions: 1 });
      const watcher = start('mock:monitoring watching a build');
      await waitFor(watcher.id, (r) => r?.activity === 'monitoring');

      const record = start('mock:spawn take the hill', caesar('m13', 20));
      await waitFor(record.id, (r) => r?.activity === 'monitoring');
      const children = childrenOf(record.id);
      expect(children).toHaveLength(2);
      for (const child of children) started.push(child.id);

      // BOTH legates reach a terminal state: the parked commander held nothing.
      for (const child of children) await waitFor(child.id, settled, 40_000);
    }, 90_000);

    it('refuses a centurion — the hierarchy stops at the rank that does the work', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn split this up', { role: 'centurion', missionId: 'm2' });
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(childrenOf(record.id)).toHaveLength(0);
      expect(notes(record.id).some((n) => n.includes('CEZ:SPAWN refused') && n.includes('no rank below it'))).toBe(true);
      // No state change beyond today's rules: a refused spawn parks the way a plain turn does.
      expect(store.getRun(record.id)?.activity).toBeUndefined();
    }, 40_000);

    it('refuses a spawn that would put a fifth child in flight', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn one more push', caesar('m3', 20));
      // Three legates already working under this commander — two more would make five.
      for (let i = 0; i < 3; i += 1) {
        const child = store.createRun({ title: `in flight ${i}`, workflow: '(planned)', task: 't', steps: [] });
        store.updateRun(child.id, {
          status: 'running',
          unit: { role: 'legate', missionId: 'm3', parentRunId: record.id },
        });
      }
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(childrenOf(record.id)).toHaveLength(3); // nothing was created
      expect(
        notes(record.id).some((n) => n.includes('CEZ:SPAWN refused') && n.includes('the cap is 4')),
      ).toBe(true);
    }, 40_000);

    it('refuses a spawn that would overspend the commander’s remaining budget', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      // Two orders at $2.50 each against a $1 mission: refused whole, not trimmed to fit.
      const record = start('mock:spawn take the hill', caesar('m4', 1));
      await waitFor(record.id, (r) => r?.status === 'waiting' || r?.activity === 'monitoring');
      expect(childrenOf(record.id)).toHaveLength(0);
      expect(notes(record.id).some((n) => n.includes('CEZ:SPAWN refused') && n.includes('budget'))).toBe(true);
    }, 40_000);

    it('answers a malformed payload with a note and no children', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn-bad delegate this', caesar('m5', 20));
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(childrenOf(record.id)).toHaveLength(0);
      expect(notes(record.id).some((n) => n.includes('CEZ:SPAWN ignored'))).toBe(true);
      // An INVALID payload stays visible in the transcript (markers.ts): it is the only record of
      // what the commander tried to do.
      const texts = store.readEvents(record.id).filter((e) => e.type === 'text');
      expect(texts.some((e) => String((e as { text?: unknown }).text).includes('CEZ:SPAWN'))).toBe(true);
    }, 40_000);

    /**
     * Audit D4: a refused marker used to be a transcript note the model never saw. An autonomous
     * commander then idled on its 15-minute timer and was settled `done` with an empty branch —
     * twice in one mission. The refusal now goes back into the open session as a re-prompt; the
     * mock answers it with CEZ:DONE, which is the proof the model got another turn.
     */
    it('delivers a refusal back into an autonomous commander’s session instead of parking it', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const stdinFile = join(repoRoot, 'mock-stdin-refusal.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const record = start('mock:spawn-bad delegate this', caesar('m5b', 20), { autonomous: true });
      await waitFor(record.id, settled);
      expect(childrenOf(record.id)).toHaveLength(0);
      expect(store.getRun(record.id)?.status).toBe('done'); // the re-prompted turn ended with DONE
      expect(notes(record.id).some((n) => n.includes('CEZ:SPAWN ignored'))).toBe(true);
      expect(notes(record.id).some((n) => n.startsWith('refusal delivered back into the session'))).toBe(true);
      const rePrompt = delivered(stdinFile, 'cez refused a control marker');
      expect(rePrompt).toContain('CEZ:SPAWN ignored');
      expect(rePrompt).toContain('corrected marker');
    }, 60_000);

    it('keeps the mock’s refusal trigger a prefix of the engine’s — reword one, this fails here', () => {
      const engine = readFileSync(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8');
      const mock = readFileSync(fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url)), 'utf8');
      const enginePrefix = /const MARKER_REFUSAL_PREFIX = '([^']+)'/.exec(engine)?.[1];
      const mockPrefix = /const MARKER_REFUSAL_PREFIX = '([^']+)'/.exec(mock)?.[1];
      expect(enginePrefix && mockPrefix && enginePrefix.startsWith(mockPrefix)).toBe(true);
    });

    it('leaves a NON-autonomous commander parked on a refusal, note only (unchanged)', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn-bad delegate this', caesar('m5c', 20));
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(notes(record.id).some((n) => n.startsWith('refusal delivered back'))).toBe(false);
    }, 40_000);
  });

  // ---- the mission directory (the filesystem channel) ---------------------------------------

  describe('the mission directory', () => {
    const missionDirOf = (missionId: string) => join(repoRoot, '.ai/cezar/missions', missionId);

    it('writes each child’s order and seeds its notes at spawn, and names the paths in the order', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn split this up', caesar('m9', 20));
      await waitFor(record.id, (r) => r?.activity === 'monitoring');
      const children = childrenOf(record.id);
      expect(children).toHaveLength(2);
      for (const child of children) {
        const dir = join(missionDirOf('m9'), 'units', child.id.slice(0, 8));
        expect(readFileSync(join(dir, 'order.md'), 'utf8')).toContain(child.title);
        expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('## Suggestions for the mission');
        // The task the child actually runs names its own files — no placeholder survives.
        expect(child.task).toContain(join(dir, 'notes.md'));
        expect(child.task).not.toContain('{{MISSION_PATHS}}');
        expect(child.task).toContain('brief.md');
      }
      const ledger = readFileSync(join(missionDirOf('m9'), 'ledger.jsonl'), 'utf8').trim().split('\n');
      expect(ledger.filter((line) => line.includes('"type":"spawn"'))).toHaveLength(2);
    }, 60_000);

    it('wakes a parked commander when a file lands in its inbox, and hands a later session the digest', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-inbox.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const parent = start('mock:monitoring waiting on my legates', caesar('m10'));
      store.updateRun(parent.id, { unit: { ...caesar('m10'), missionId: parent.id } });
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      // A child whose turn ends is the SIGNAL: it wrote into the root's inbox, then finished.
      const inbox = join(missionDirOf(parent.id), 'inbox', 'root');
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'scope-question.md'), '# Scope\n\nMay I touch billing?\n');
      const child = start('mock:report take the left flank', {
        role: 'legate',
        missionId: parent.id,
        parentRunId: parent.id,
      });
      await waitFor(child.id, settled);
      await waitFor(parent.id, () => stdin(stdinFile).includes('Mission inbox'));
      const notice = delivered(stdinFile, 'Mission inbox');
      expect(notice).toContain(join(inbox, 'scope-question.md'));
      expect(store.getRun(parent.id)?.unit?.inboxSeenAt).toBeTruthy();
      expect(notes(parent.id).some((n) => n.includes('new mission inbox message'))).toBe(true);
    }, 60_000);

    it('forwards a settled child’s suggestions to the root’s inbox', async () => {
      const parent = start('mock:monitoring waiting', caesar('m11'));
      store.updateRun(parent.id, { unit: { ...caesar('m11'), missionId: parent.id } });
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      const child = start('mock:report-suggest take the right flank', {
        role: 'legate',
        missionId: parent.id,
        parentRunId: parent.id,
      });
      await waitFor(child.id, settled);
      const files = readdirSync(join(missionDirOf(parent.id), 'inbox', 'root'));
      const suggestion = files.find((name) => name.includes('suggestions'));
      expect(suggestion).toBeTruthy();
      expect(readFileSync(join(missionDirOf(parent.id), 'inbox', 'root', suggestion!), 'utf8')).toContain('split billing out of this order');
      expect(readFileSync(join(missionDirOf(parent.id), 'units', child.id.slice(0, 8), 'report.md'), 'utf8')).toContain('"status": "done"');
    }, 60_000);
  });

  // ---- flexible composition and per-mission resources ---------------------------------------

  describe('rank, kind and mission resources', () => {
    it('lets a caesar spawn centurions directly, one of them a reviewer with a review target', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn-direct split this up', caesar('m12', 20));
      await waitFor(record.id, (r) => r?.activity === 'monitoring');
      const children = childrenOf(record.id);
      expect(children.map((c) => c.unit?.role)).toEqual(['centurion', 'centurion']);
      const reviewer = children.find((c) => c.unit?.kind === 'review');
      expect(reviewer?.unit?.reviewOf).toEqual(['cez/00000000']);
      expect(reviewer?.task).toContain('- Kind: review');
      // The record echoes the system prompt a run used once it has RUN (execute writes it), so
      // let both children settle before reading theirs.
      for (const child of children) await waitFor(child.id, settled, 40_000);
      expect(store.getRun(reviewer!.id)?.systemPrompt).toMatch(/Your KIND is review/);
      const implementer = children.find((c) => c.unit?.kind === undefined);
      expect(store.getRun(implementer!.id)?.systemPrompt).not.toMatch(/Your KIND is/);
      expect(store.getRun(implementer!.id)?.systemPrompt).toMatch(/CENTURION/);
      expect(notes(record.id).some((n) => n.includes('centurion, review'))).toBe(true);
    }, 60_000);

    it('caps children in flight at the mission’s own maxChildren', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn one more push', caesar('m13', 20));
      // The mission root's own record carries the resources; here the root IS this run.
      store.updateRun(record.id, { unit: { ...caesar('m13', 20), missionId: record.id, resources: { maxChildren: 1 } } });
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(childrenOf(record.id)).toHaveLength(0);
      expect(notes(record.id).some((n) => n.includes('CEZ:SPAWN refused') && n.includes('the cap is 1'))).toBe(true);
    }, 40_000);

    it('runs a mission with its own parallel limit wider than the workspace cap, without widening the cap', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const root = store.createRun({ title: 'army', workflow: 'quick-task', task: 'hold', steps: [] });
      store.updateRun(root.id, { status: 'waiting', unit: { role: 'caesar', missionId: root.id, resources: { parallel: 2 } } });
      const unit = (title: string): RunUnit => ({ role: 'centurion', missionId: root.id, parentRunId: root.id });
      const a = start('mock:slow first flank', unit('a'));
      const b = start('mock:slow second flank', unit('b'));
      // Both mission runs execute at once under the mission's count of 2 …
      await waitFor(a.id, (r) => r?.status === 'running');
      await waitFor(b.id, (r) => r?.status === 'running');
      // … and an ordinary run still gets the workspace's single slot, because mission runs are
      // exempt from it rather than consuming it.
      const plain = start('mock:done ordinary task');
      await waitFor(plain.id, (r) => r?.status === 'running' || settled(r));
      // A third mission run waits for the mission's own count.
      const c = start('mock:slow third flank', unit('c'));
      await new Promise((r) => setTimeout(r, 1_500));
      expect(store.getRun(c.id)?.status).toBe('queued');
    }, 60_000);

    it('keeps a mission with no parallel limit under the workspace cap, exactly as before', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const root = store.createRun({ title: 'army', workflow: 'quick-task', task: 'hold', steps: [] });
      store.updateRun(root.id, { status: 'waiting', unit: { role: 'caesar', missionId: root.id } });
      const a = start('mock:slow first flank', { role: 'centurion', missionId: root.id, parentRunId: root.id });
      const b = start('mock:slow second flank', { role: 'centurion', missionId: root.id, parentRunId: root.id });
      await waitFor(a.id, (r) => r?.status === 'running');
      await new Promise((r) => setTimeout(r, 1_500));
      expect(store.getRun(b.id)?.status).toBe('queued');
    }, 60_000);
  });

  // ---- the pending question (the Guard, Q4) -------------------------------------------------

  describe('pendingAsk', () => {
    it('records a unit run’s question when it parks and clears it when an answer is delivered', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:ask which library?', caesar('m8'), { autonomous: true });
      await waitFor(record.id, (r) => r?.status === 'waiting');
      const pending = store.getRun(record.id)?.unit?.pendingAsk;
      expect(pending?.questions).toHaveLength(1);
      expect(pending?.askedAt).toBeTruthy();
      expect(manager.sendMessage(record.id, [{ type: 'text', text: 'mock:done use date-fns' }])).toBe(true);
      expect(store.getRun(record.id)?.unit?.pendingAsk).toBeUndefined();
      await waitFor(record.id, settled);
    }, 40_000);
  });

  // ---- reporting ----------------------------------------------------------------------------

  describe('CEZ:REPORT and the settle→parent wake', () => {
    it('stores a report emitted with CEZ:DONE on the next line, and strips it from the transcript', async () => {
      const record = start('mock:report finish the flank', { role: 'centurion', missionId: 'm6' });
      await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');
      const settled = store.getRun(record.id);
      expect(settled?.unit?.report?.status).toBe('done');
      expect(settled?.unit?.report?.evidence).toContain('src/auth/login.ts:42');
      const texts = store.readEvents(record.id).filter((e) => e.type === 'text');
      expect(texts.some((e) => String((e as { text?: unknown }).text).includes('CEZ:REPORT'))).toBe(false);
    }, 40_000);

    it('delivers a settled child’s report into its parent’s open session', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const parent = start('mock:monitoring waiting on my legates', caesar('m7'));
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      const child = start('mock:report take the left flank', {
        role: 'legate',
        missionId: 'm7',
        parentRunId: parent.id,
      });
      await waitFor(child.id, (r) => r?.status === 'done' || r?.status === 'review');

      // Q7 rung 1: the parent's live session heard it.
      await waitFor(parent.id, () => stdin(stdinFile).includes('Report from legate'));
      const text = delivered(stdinFile, 'Report from legate');
      expect(text).toContain(`"${store.getRun(child.id)?.title}"`);
      expect(text).toContain(child.id);
      expect(text).toContain('status done');
      // The branch is what makes a report actionable — it is what the parent has to merge (Q3).
      expect(text).toContain(`branch ${store.getRun(child.id)?.branch}`);
      // Delivering wakes the monitor: it is working again, not parked.
      expect(store.getRun(parent.id)?.activity).toBeUndefined();
      // The delivery is not user-authored, so the thread would otherwise show nothing at all.
      expect(notes(parent.id).some((n) => n.startsWith('report received from legate'))).toBe(true);
      // Persist-then-ACK: the report was written to the record BEFORE the delivery (that is what
      // survives a restart mid-hand-off), and the live session taking it is what retires the
      // entry. Leaving it behind is not "belt and braces" — `flushPendingReports` would then
      // prepend this same report to every session this commander ever opens again.
      await waitFor(parent.id, (r) => (r?.unit?.pendingReports?.length ?? 0) === 0);
    }, 60_000);

    it('does not re-flush a live-delivered report into the parent’s next session', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const parent = start('mock:monitoring waiting on my legates', caesar('m14'));
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      const child = start('mock:report take the left flank', {
        role: 'legate',
        missionId: 'm14',
        parentRunId: parent.id,
      });
      await waitFor(child.id, (r) => r?.status === 'done' || r?.status === 'review');
      await waitFor(parent.id, () => stdin(stdinFile).includes('Report from legate'));

      // Let the commander finish the turn the report started, then close its session: what is
      // under test is the NEXT one. (Whether the fixture's own reply ends that turn or parks it
      // is not this test's business, so both endings are driven to the same settled state.)
      await waitFor(parent.id, (r) => settled(r) || r?.status === 'waiting');
      if (store.getRun(parent.id)?.status === 'waiting') expect(manager.finish(parent.id)).toBe(true);
      await waitFor(parent.id, settled);
      expect(manager.continueRun(parent.id, { text: 'mock:done regroup the century' }).ok).toBe(true);
      await waitFor(parent.id, () => stdin(stdinFile).includes('regroup the century'));

      // The continuation's OPENING prompt is where `flushPendingReports` prepends its block. The
      // commander was already told about this child live, so telling it again — on this session
      // and on every one after it — is a report delivered twice.
      const opening = delivered(stdinFile, 'regroup the century');
      expect(opening).toBeDefined();
      expect(opening).not.toContain('## Reports from your units');
      expect(opening).not.toContain(child.id);
    }, 60_000);

    it('persists a pending report for a parent with no session, and flushes it into its next prompt', async () => {
      // A parent that exists only as a record — exactly what a restart leaves behind.
      const parent = store.createRun({
        title: 'commander',
        workflow: '(planned)',
        task: 'hold the line',
        steps: [],
      });
      store.updateRun(parent.id, { status: 'waiting', unit: caesar('m8') });

      const child = start('mock:report take the right flank', {
        role: 'legate',
        missionId: 'm8',
        parentRunId: parent.id,
      });
      await waitFor(child.id, (r) => r?.status === 'done' || r?.status === 'review');
      await waitFor(parent.id, (r) => (r?.unit?.pendingReports?.length ?? 0) > 0);

      const pending = store.getRun(parent.id)?.unit?.pendingReports ?? [];
      expect(pending).toHaveLength(1);
      expect(pending[0]?.title).toBe(child.title);
      expect(pending[0]?.report.status).toBe('done');

      // The flush is what the parent's next session actually reads.
      const flushed = (manager as unknown as {
        flushPendingReports(id: string): string | undefined;
      }).flushPendingReports(parent.id);
      expect(flushed).toContain('## Reports from your units');
      expect(flushed).toContain(child.id);
      expect(store.getRun(parent.id)?.unit?.pendingReports).toBeUndefined(); // cleared, never re-read
    }, 60_000);
  });

  // ---- brakes -------------------------------------------------------------------------------

  it('parks an over-budget run at waiting — no autonomous nudge, no wake timer (Q6 ii)', async () => {
    // A ceiling the first mock turn ($0.0342) is already past. `mock:monitoring` would normally
    // park as a monitor WITH a wake deadline; the brake must beat it.
    const record = start('mock:monitoring keep going', { role: 'centurion', missionId: 'm9', budgetUsd: 0.001 }, {
      autonomous: true,
    });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const parked = store.getRun(record.id);
    expect(parked?.status).toBe('waiting');
    expect(parked?.activity).toBeUndefined();
    expect(parked?.unit?.overBudget).toBe(true);
    expect(parked?.monitoringWakeAt).toBeUndefined(); // the wake timer is cleared, not armed
    expect(activeState(record.id)?.monitoringWakeTimer).toBeUndefined();
    expect(notes(record.id).some((n) => n.includes('budget spent'))).toBe(true);
    expect(notes(record.id).some((n) => n.includes('autonomous — continuing'))).toBe(false);
  }, 40_000);

  it('cancels a whole subtree, deepest first', async () => {
    // Frozen queue: the tree exists as records and nothing spawns a process.
    reboot({ maxParallel: 0 });
    const root = start('hold', { role: 'caesar', missionId: 'm10' });
    const legate = start('flank', { role: 'legate', missionId: 'm10', parentRunId: root.id });
    const centurion = start('dig', { role: 'centurion', missionId: 'm10', parentRunId: legate.id });

    expect(manager.cancel(root.id)).toBe(true);
    for (const id of [root.id, legate.id, centurion.id]) {
      expect(store.getRun(id)?.status).toBe('cancelled');
    }
  }, 20_000);

  /**
   * A cascade cancels children FIRST, so every child settles around — and routinely after — its
   * own commander. Both rungs of the settle→parent ladder have to survive that ordering, and
   * each is pinned on its own below because the live cascade cannot schedule the race for us.
   */
  describe('a cancel is final — nothing below may undo it', () => {
    it('persists a cancelled child’s report without waking its commander', async () => {
      // No monitoring exemption, one slot: the commander parks on its own monitor and the legate
      // stays QUEUED, so the cancel path under test is the queued one — synchronous, no race.
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = start('mock:monitoring holding the line', caesar('m15'));
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      const child = start('take the left flank', {
        role: 'legate',
        missionId: 'm15',
        parentRunId: parent.id,
      });
      await waitFor(child.id, (r) => r?.status === 'queued');

      expect(manager.cancel(child.id)).toBe(true);
      await waitFor(parent.id, (r) => (r?.unit?.pendingReports?.length ?? 0) > 0);

      // A cancelled child is the one settle that must not wake anybody: in a cascade its
      // commander is already cancelled (or being cancelled) by the time its process dies, and a
      // live delivery there restarts a turn on a session being torn down.
      expect(store.getRun(parent.id)?.status).toBe('running');
      expect(store.getRun(parent.id)?.activity).toBe('monitoring');
      // Nothing is lost: the report is on the record for the commander's next session.
      expect(store.getRun(parent.id)?.unit?.pendingReports?.[0]?.fromRunId).toBe(child.id);
      expect(store.getRun(parent.id)?.unit?.pendingReports?.[0]?.report.status).toBe('blocked');
    }, 40_000);

    it('never continues a cancelled commander from a child that settles after it', async () => {
      // The order the cascade produces, made deterministic: the commander is cancelled first and
      // its legate settles afterwards. `continueRun` permits a `cancelled` run — that is the
      // user's own Continue button — so the last rung of the report ladder used to re-queue the
      // very mission the user had just stopped.
      const parent = start('mock:monitoring holding the line', caesar('m16'));
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      expect(manager.cancel(parent.id)).toBe(true);
      await waitFor(parent.id, (r) => r?.status === 'cancelled');

      const child = start('mock:report take the left flank', {
        role: 'legate',
        missionId: 'm16',
        parentRunId: parent.id,
      });
      await waitFor(child.id, (r) => r?.status === 'done' || r?.status === 'review');
      await waitFor(parent.id, (r) => (r?.unit?.pendingReports?.length ?? 0) > 0);
      await new Promise((r) => setTimeout(r, 500));

      const root = store.getRun(parent.id);
      expect(root?.status).toBe('cancelled'); // not resurrected as `queued`
      expect(root?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
      expect(manager.isActive(parent.id)).toBe(false);
      // The report still reached the record, so a human Continue picks it up.
      expect(root?.unit?.pendingReports?.[0]?.fromRunId).toBe(child.id);
    }, 60_000);

    it('leaves a whole cancelled army settled, with no run brought back', async () => {
      const root = start('mock:spawn take the hill', caesar('m17', 20));
      await waitFor(root.id, (r) => r?.activity === 'monitoring');
      const children = childrenOf(root.id);
      expect(children).toHaveLength(2);
      for (const child of children) started.push(child.id);

      expect(manager.cancel(root.id)).toBe(true);
      for (const id of [root.id, ...children.map((c) => c.id)]) await waitFor(id, settled);
      // Every child's teardown has to have run before this is worth asserting.
      await new Promise((r) => setTimeout(r, 1_500));

      const settledRoot = store.getRun(root.id);
      expect(settledRoot?.status).toBe('cancelled');
      expect(settledRoot?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
      expect(manager.isActive(root.id)).toBe(false);
    }, 90_000);
  });

  // ---- the Guard (Q4) -----------------------------------------------------------------------

  describe('the Guard: an autonomous unit run never answers its own CEZ:ASK', () => {
    /**
     * The autonomous auto-continue lives in ONE place — `runContinuation`'s turn-end — and it
     * reads `ActiveRun.autonomous`, which today only `execute` ever writes: a continuation builds
     * its own `ActiveRun` and leaves the flag unset (the exact "one construction site populated"
     * shape AGENTS.md describes, here with the READER on the other side). That is pre-existing
     * behaviour and deliberately not changed here — a fresh nudge on every Continue would be a
     * default-path change for every autonomous run in the repo, far outside this feature.
     *
     * So the flag is armed on the live session instead, which is what makes the guarded branch
     * REACHABLE at all: without it neither of these two tests can tell the guard from the dead
     * code around it, and both would pass with the guard deleted.
     */
    const armAutonomous = async (id: string): Promise<void> => {
      const active = (manager as unknown as { active: Map<string, { autonomous?: boolean }> }).active;
      const deadline = Date.now() + 10_000;
      while (!active.has(id)) {
        if (Date.now() > deadline) throw new Error('the continuation never opened');
        await new Promise((r) => setTimeout(r, 2));
      }
      const state = active.get(id);
      if (state) state.autonomous = true;
    };

    /** Drive one run to `done`, then continue it with a turn that ends in CEZ:ASK. */
    const askOnContinue = async (unit?: RunUnit): Promise<string> => {
      const record = start('mock:done first pass', unit, { autonomous: true });
      await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');
      const resumed = manager.continueRun(record.id, { text: 'mock:ask which library?' });
      expect(resumed.ok).toBe(true);
      await armAutonomous(record.id);
      return record.id;
    };

    it('parks a unit run at waiting with the ask card instead of nudging it onward', async () => {
      const id = await askOnContinue({ role: 'legate', missionId: 'm11' });
      await waitFor(id, (r) => r?.status === 'waiting');
      expect(store.readEvents(id).some((e) => e.type === 'ask.requested')).toBe(true);
      expect(notes(id).some((n) => n.includes('autonomous — continuing'))).toBe(false);
    }, 60_000);

    it('leaves a NON-unit autonomous run auto-continuing, exactly as before', async () => {
      const id = await askOnContinue();
      await waitFor(id, () => notes(id).some((n) => n.includes('autonomous — continuing')));
      expect(notes(id).some((n) => n.includes('autonomous — continuing without pausing (1/40)'))).toBe(true);
      // …and it never parked for the question it asked itself.
      expect(store.getRun(id)?.status).not.toBe('waiting');
    }, 60_000);
  });

  // ---- the gate -----------------------------------------------------------------------------

  describe('a run with no unit is untouched', () => {
    it('ignores every unit marker and settles the way it always did', async () => {
      // The same turn that would spawn two legates: with no `unit` on the record it is prose.
      const record = start('mock:spawn and mock:done in one turn');
      await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');
      expect(store.listRuns()).toHaveLength(1); // nothing was spawned
      expect(store.getRun(record.id)?.unit).toBeUndefined();
      expect(notes(record.id).some((n) => n.includes('CEZ:SPAWN'))).toBe(false);
      // …and its own text is persisted byte-for-byte, marker and all.
      const texts = store.readEvents(record.id).filter((e) => e.type === 'text');
      expect(texts.some((e) => String((e as { text?: unknown }).text).includes('CEZ:SPAWN'))).toBe(true);
    }, 40_000);

    it('ignores unit markers on a unit run while CEZ_UNITS is off', async () => {
      delete process.env.CEZ_UNITS;
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:spawn take the hill', caesar('m12', 20));
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(childrenOf(record.id)).toHaveLength(0);
      expect(notes(record.id).some((n) => n.includes('CEZ:SPAWN'))).toBe(false);
    }, 40_000);
  });
});
