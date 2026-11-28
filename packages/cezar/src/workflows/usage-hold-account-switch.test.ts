import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { readLoginIdentity } from '../workspace/usage-limit-logins.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Scheduler = {
  autoResumeTimers: Map<string, ReturnType<typeof setTimeout>>;
  fireAutoResume(runId: string): void;
  pump(): Promise<void>;
};

/**
 * The usage-limit hold after the account behind it changed (spec
 * 2026-08-03-auto-resume-after-usage-limit, 2026-11-23 addendum). Reported: account A hit its
 * limit, the user re-logged the Claude CLI into B and restarted cezar, and 13 tasks in three
 * projects stayed queued behind one resumed run until it finished its whole turn.
 *
 * Every case drives the real engine through the bundled mock (`CEZ_DRY_RUN=1`); the login is the
 * real `.claude.json` of a temporary `CLAUDE_CONFIG_DIR`, which is all cezar reads to tell
 * logins apart.
 */
describe('the usage-limit hold follows the account, not just its profile folder', () => {
  const workflow = QUICK_TASK_WORKFLOW;
  const saved: Record<string, string | undefined> = {};
  const temp: string[] = [];
  const stores = new Map<string, RunStore>();
  const managers: RunManager[] = [];
  let claudeHome: string;

  async function repo(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'cez-hold-switch-'));
    temp.push(root);
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    stores.set(root, RunStore.open(join(root, '.ai/cezar')));
    return root;
  }
  const storeOf = (root: string) => stores.get(root)!;
  const manage = (manager: RunManager) => { managers.push(manager); return manager; };
  /** The Claude login the default account's folder holds (only `accountUuid`/`organizationUuid` count). */
  const signIn = (account: string) =>
    writeFileSync(join(claudeHome, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: 'org-1' } }));

  async function settle(store: RunStore, runId: string): Promise<void> {
    await expect.poll(() => store.getRun(runId)?.status, { timeout: 20_000 }).toMatch(/^(done|review|failed|cancelled)$/);
  }
  /** Deliver the armed resume now instead of after the provider's window (the window ends now). */
  function fireNow(manager: RunManager, store: RunStore, runId: string): void {
    const scheduler = manager as unknown as Scheduler;
    clearTimeout(scheduler.autoResumeTimers.get(runId));
    store.updateRun(runId, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    scheduler.fireAutoResume(runId);
  }
  async function stop(manager: RunManager, store: RunStore): Promise<void> {
    for (const { id } of store.listRuns()) manager.cancel(id);
    await expect.poll(() => store.listRuns().some(({ id }) => manager.isActive(id)), { timeout: 10_000 }).toBe(false);
    manager.dispose();
  }
  /** A limited run plus a fresh one queued behind its hold, in `root`. */
  async function limitedWithQueue(manager: RunManager, root: string) {
    const store = storeOf(root);
    const limited = manager.startRun(workflow, { task: 'mock:limit first' });
    await settle(store, limited.id);
    expect(store.getRun(limited.id)?.autoResumeAt).toBeDefined();
    const fresh = manager.startRun(workflow, { task: 'mock:done fresh' });
    await sleep(750);
    expect(store.getRun(fresh.id)?.status).toBe('queued');
    return { limited, fresh };
  }

  beforeEach(() => {
    for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_LIMIT_RESET_SECONDS', 'CEZ_HOME', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    // Far enough out that no resume fires on its own mid-test.
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    // A fresh home per case: a lifted or released account must not leak into the next one.
    process.env.CEZ_HOME = mkdtempSync(join(tmpdir(), 'cez-hold-home-'));
    claudeHome = mkdtempSync(join(tmpdir(), 'cez-hold-claude-'));
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    temp.push(process.env.CEZ_HOME, claudeHome);
  });

  afterEach(async () => {
    const list = managers.splice(0);
    for (const manager of list) {
      for (const store of stores.values()) for (const { id } of store.listRuns()) manager.cancel(id);
    }
    await sleep(300);
    for (const manager of list) manager.dispose();
    vi.restoreAllMocks();
    for (const store of stores.values()) store.flush();
    stores.clear();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('cancelling a RUNNING resume releases its account in every project (fix 1)', async () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 3 } });
    const [rootA, rootB] = [await repo(), await repo()];
    const a = manage(new RunManager(storeOf(rootA), rootA, { semaphore }));
    const b = manage(new RunManager(storeOf(rootB), rootB, { semaphore }));
    const limited = a.startRun(workflow, { task: 'mock:limit first' });
    await settle(storeOf(rootA), limited.id);
    // The reported state: the resume is running (no deadline left), its counter holds the account.
    storeOf(rootA).updateRun(limited.id, { task: 'mock:slow resumed' });
    fireNow(a, storeOf(rootA), limited.id);
    await expect.poll(() => storeOf(rootA).getRun(limited.id)?.status, { timeout: 15_000 }).toBe('running');
    expect(storeOf(rootA).getRun(limited.id)?.autoResumeAt).toBeUndefined();
    const fresh = b.startRun(workflow, { task: 'mock:done fresh in b' });
    await sleep(750);
    expect(storeOf(rootB).getRun(fresh.id)?.status).toBe('queued');

    a.cancelAutoResume(limited.id);
    // No other trigger: the other project's queue moves because the cancel released it.
    await expect.poll(() => storeOf(rootB).getRun(fresh.id)?.startedAt, { timeout: 8_000 }).toBeDefined();
    expect(storeOf(rootA).getRun(limited.id)?.status).toBe('running');
  }, 60_000);

  it('a resume that sees its window open starts the queued work at once, before its turn ends (fix 2, on #2525\'s flag)', async () => {
    const root = await repo();
    const manager = manage(new RunManager(storeOf(root), root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) }));
    const { limited, fresh } = await limitedWithQueue(manager, root);
    storeOf(root).updateRun(limited.id, { task: 'mock:linger resumed' });
    fireNow(manager, storeOf(root), limited.id);

    await expect.poll(() => storeOf(root).getRun(fresh.id)?.startedAt, { timeout: 8_000 }).toBeDefined();
    const resumed = storeOf(root).getRun(limited.id);
    expect(resumed?.status).toBe('running'); // its ~25 s turn is still going
    expect(resumed?.autoResumeWindowOpen).toBe(true);
    // The open window ends the hold, not the consecutive-resume cap.
    expect(resumed?.autoResumeAttempts).toBe(1);
  }, 60_000);

  it('guard (passes before and after): a resume that meets the limit again sees no open window — the queue stays held', async () => {
    // A re-limit reports no open window: nothing may start into the closed one.
    const root = await repo();
    const manager = manage(new RunManager(storeOf(root), root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) }));
    const { limited, fresh } = await limitedWithQueue(manager, root);
    fireNow(manager, storeOf(root), limited.id);
    await expect.poll(() => storeOf(root).getRun(limited.id)?.status, { timeout: 15_000 }).toBe('failed');
    await expect.poll(() => storeOf(root).getRun(limited.id)?.autoResumeAt, { timeout: 5_000 }).toBeDefined();
    await sleep(1_000);
    expect(storeOf(root).getRun(fresh.id)?.startedAt).toBeUndefined();
    expect(storeOf(root).getRun(limited.id)?.autoResumeWindowOpen).toBeUndefined();
  }, 60_000);

  it('signing the profile into another account lifts the deadline: queued work starts, the parked task resumes (fix 3)', async () => {
    signIn('account-a');
    const root = await repo();
    const manager = manage(new RunManager(storeOf(root), root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) }));
    const { limited, fresh } = await limitedWithQueue(manager, root);
    storeOf(root).updateRun(limited.id, { task: 'mock:done resumed' });

    signIn('account-b');
    await manager.rescueStalledQueue(); // the 60 s watchdog tick, driven directly

    await expect.poll(() => storeOf(root).getRun(fresh.id)?.startedAt, { timeout: 15_000 }).toBeDefined();
    const said = (text: string) => storeOf(root).readEvents(limited.id).some((event) => String(event.message ?? '').includes(text));
    await expect.poll(() => said('resuming automatically (1/'), { timeout: 15_000 }).toBe(true);
    expect(said('another login')).toBe(true);
  }, 60_000);

  it('a login lift fires the parked resume first, and fresh work waits until it sees its window (fix 3)', async () => {
    signIn('account-a');
    const root = await repo();
    const manager = manage(new RunManager(storeOf(root), root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 3 } }) }));
    const { limited, fresh } = await limitedWithQueue(manager, root);
    // A long resumed turn that reports no window: nothing proves B answers yet.
    storeOf(root).updateRun(limited.id, { task: 'mock:slow resumed' });

    signIn('account-b');
    await manager.rescueStalledQueue();
    await expect.poll(() => storeOf(root).getRun(limited.id)?.status, { timeout: 15_000 }).toBe('running');
    await sleep(1_500);
    expect(storeOf(root).getRun(fresh.id)?.startedAt).toBeUndefined();
    expect(storeOf(root).getRun(fresh.id)?.queueWaitReason).toEqual({ kind: 'account-resume' });
  }, 60_000);

  it('switching back to the limited login outside cezar holds again, however recently B was read (A → B → A)', async () => {
    signIn('account-a');
    const root = await repo();
    const manager = manage(new RunManager(storeOf(root), root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) }));
    const { limited, fresh } = await limitedWithQueue(manager, root);
    signIn('account-b');
    await readLoginIdentity('claude:default'); // cezar saw B…
    signIn('account-a'); // …then the user signed A back in, and cezar has not looked since.
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 6_000);
    await (manager as unknown as Scheduler).pump();
    await sleep(1_500);
    expect(storeOf(root).getRun(fresh.id)?.startedAt).toBeUndefined();
    // Not even the parked resume is sent into A off the stale read.
    expect(storeOf(root).readEvents(limited.id).some((event) => String(event.message ?? '').includes('another login'))).toBe(false);
    expect(storeOf(root).getRun(limited.id)).toMatchObject({ status: 'failed' });
  }, 60_000);

  it('guard (passes before and after): an unreadable login is not a new one — the hold stays', async () => {
    signIn('account-a');
    const root = await repo();
    const manager = manage(new RunManager(storeOf(root), root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) }));
    const { limited, fresh } = await limitedWithQueue(manager, root);
    // Logged out, or `.claude.json` caught mid-rewrite.
    rmSync(join(claudeHome, '.claude.json'));
    await manager.rescueStalledQueue();
    await sleep(1_000);
    expect(storeOf(root).getRun(fresh.id)?.startedAt).toBeUndefined();
    expect(storeOf(root).getRun(limited.id)?.autoResumeAt).toBeDefined();
  }, 60_000);

  it('a project not opened since the limit still holds the account at boot (fix 5)', async () => {
    const [bootRoot, otherRoot] = [await repo(), await repo()];
    // The other project hit the limit in an earlier session; nobody has opened it since.
    const earlier = new RunManager(storeOf(otherRoot), otherRoot);
    const limited = earlier.startRun(workflow, { task: 'mock:limit in the other project' });
    await settle(storeOf(otherRoot), limited.id);
    expect(storeOf(otherRoot).getRun(limited.id)?.autoResumeAt).toBeDefined();
    earlier.dispose();
    storeOf(otherRoot).flush();
    // The boot project had a task queued when cezar stopped.
    const before = new RunManager(storeOf(bootRoot), bootRoot);
    const pump = vi.spyOn(before as unknown as Scheduler, 'pump').mockResolvedValue();
    const queued = before.startRun(workflow, { task: 'mock:done queued at boot' });
    pump.mockRestore();
    before.dispose();

    // Boot: the semaphore reads the registry, then the boot project recovers and pumps first.
    const semaphore = new WorkspaceSemaphore({
      load: async () => ({ maxParallel: 2, memoryLimitMb: null, projectRoots: [bootRoot, otherRoot] }),
    });
    await semaphore.refresh();
    const boot = manage(new RunManager(storeOf(bootRoot), bootRoot, { semaphore }));
    await boot.recover();
    await sleep(1_000);
    expect(storeOf(bootRoot).getRun(queued.id)?.status).toBe('queued');
    expect(storeOf(bootRoot).getRun(queued.id)?.startedAt).toBeUndefined();
  }, 60_000);

  it('guard (passes before and after): a restart keeps a resume that saw its window open released, and keeps its counter (#2525)', async () => {
    const root = await repo();
    const dataDir = join(root, '.ai/cezar');
    const manager = new RunManager(storeOf(root), root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) });
    const limited = manager.startRun(workflow, { task: 'mock:limit first' });
    await settle(storeOf(root), limited.id);
    storeOf(root).updateRun(limited.id, { task: 'mock:linger resumed' });
    fireNow(manager, storeOf(root), limited.id);
    await expect.poll(() => storeOf(root).getRun(limited.id)?.autoResumeWindowOpen, { timeout: 15_000 }).toBe(true);

    // cezar dies mid-turn: keep runs.json as the crash left it, then stop the old process's work.
    storeOf(root).flush();
    const crashed = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    await stop(manager, storeOf(root));
    storeOf(root).flush();
    writeFileSync(join(dataDir, 'runs.json'), crashed);

    const store = RunStore.open(dataDir, { keepLive: true });
    stores.set(root, store);
    const restarted = manage(new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) }));
    await restarted.recover();
    // Not held for the resumed run's whole turn again…
    expect(restarted.accountHolds().inFlight.size).toBe(0);
    // …and the cap still counts this resume.
    expect(store.getRun(limited.id)?.autoResumeAttempts).toBe(1);
    const fresh = restarted.startRun(workflow, { task: 'mock:done after the restart' });
    await expect.poll(() => store.getRun(fresh.id)?.startedAt, { timeout: 15_000 }).toBeDefined();
  }, 60_000);
});
