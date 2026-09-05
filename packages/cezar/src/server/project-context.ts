import { join } from 'node:path';
import { AutomationStore } from '../automations/store.ts';
import { reconcileAutomationReceipts } from '../automations/task-template.ts';
import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from '../config.ts';
import { pruneOrphans } from '../git-worktree.ts';
import { armRepoHandle } from '../runs/arm-repo-handle.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from '../workflows/run.ts';
import { ensureLaunchKey } from './launch-key.ts';
import { getRepoInfo } from './git.ts';

/**
 * Per-project server context (spec 2026-07-20-multi-project-workspace,
 * "Project contexts" + "Boot flow"): one `{store, manager, dataDir,
 * launchKey}` bundle per registered project, built lazily on first access.
 *
 * Building a context mirrors what `serveCommand` does for the boot project
 * today — `RunStore.open(dataDir, { keepLive: true })`, `new RunManager`,
 * orphan-worktree prune + count-based retention when the root is a git repo,
 * then `manager.recover()` — so a project opened from the sidebar gets the
 * exact same crash recovery the boot project gets. A registry entry whose
 * root is gone (`status: 'missing'`) is never instantiated; `context()`
 * throws a typed `ProjectContextError` the route layer maps to 409 (and
 * `unknown-project` to 404).
 */

/** The per-project bundle the routes operate on. */
export interface ProjectContext {
  /** Registry project id (slug). */
  id: string;
  /** Realpath'd repo root the registry holds for this project. */
  root: string;
  /** `<root>/.ai/cezar` — all of this project's on-disk state. */
  dataDir: string;
  store: RunStore;
  manager: RunManager;
  automationStore: AutomationStore;
  /** Bookmarklet auto-start secret (spec 011), ensured at context build. */
  launchKey: string;
}

/** Minimal registry shape the context map needs — matches
 *  `workspace/projects.ts` `ProjectListEntry` structurally, but injected so
 *  tests stay hermetic (no `~/.cezar` reads). */
export interface ProjectContextSource {
  id: string;
  root: string;
  /** `missing` roots are never instantiated; `ok`/`not-git` both build. */
  status: 'ok' | 'missing' | 'not-git';
}

export interface ProjectContextDeps {
  /** Registry lookup — the workspace `listProjects()` in production. */
  listProjects: () => Promise<readonly ProjectContextSource[]>;
  /** Resolve the one automation store owned by this project. Production
   *  injects the workspace automation coordinator's cached store so API
   *  mutations and scheduler reads share the same in-memory state. */
  automationStore?: (projectId: string, root: string) => AutomationStore;
  /** Workspace-wide parallel-cap semaphore (spec 2026-07-20, step 2.5). Boot
   *  passes the ONE instance it already gave the boot manager, so every
   *  project's RunManager counts against the same `resources.maxParallel`.
   *  When omitted, the map still shares one private instance across the
   *  managers it builds (workspace defaults, never refreshed). */
  semaphore?: WorkspaceSemaphore;
}

export type ProjectContextFailure = 'unknown-project' | 'missing-root';

/** Typed failure so the route layer can map reasons to statuses (404/409)
 *  without string matching. */
export class ProjectContextError extends Error {
  constructor(
    readonly reason: ProjectContextFailure,
    readonly projectId: string,
  ) {
    super(
      reason === 'unknown-project'
        ? `unknown project: ${projectId}`
        : `project root is missing: ${projectId}`,
    );
    this.name = 'ProjectContextError';
  }
}

/**
 * Lazy `Map<projectId, ProjectContext>`. Nothing is instantiated at
 * construction — the boot project is built eagerly by the caller via
 * `context(bootId)`; every other project on first API touch. Concurrent
 * `context()` calls for the same id share one build (the in-flight promise is
 * cached), so recovery never runs twice for a project.
 */
export class ProjectContexts {
  private readonly contexts = new Map<string, ProjectContext>();
  private readonly building = new Map<string, Promise<ProjectContext>>();
  /** Live store-created subscribers; invoked before RunManager recovery. */
  private readonly storeListeners = new Set<(store: RunStore) => void>();
  /** Live `onContextBuilt` subscribers (workspace SSE, step 2.8). */
  private readonly builtListeners = new Set<(ctx: ProjectContext) => void>();
  /** One semaphore for every manager this map builds — injected by boot,
   *  private-but-shared otherwise. */
  private readonly semaphore: WorkspaceSemaphore;

  constructor(private readonly deps: ProjectContextDeps) {
    this.semaphore = deps.semaphore ?? new WorkspaceSemaphore();
  }

  /** The built context for `projectId`, building it on first access.
   *  Throws `ProjectContextError` for unknown ids and missing roots. */
  async context(projectId: string): Promise<ProjectContext> {
    const existing = this.contexts.get(projectId);
    if (existing) return existing;
    const inFlight = this.building.get(projectId);
    if (inFlight) return inFlight;
    const build = this.build(projectId);
    this.building.set(projectId, build);
    try {
      const ctx = await build;
      this.contexts.set(projectId, ctx);
      this.notifyBuilt(ctx);
      return ctx;
    } finally {
      this.building.delete(projectId);
    }
  }

  /**
   * Subscribe to future context builds (multi-project spec, step 2.8): the
   * workspace SSE stream attaches to every already-built context at connect
   * and uses this hook to pick up contexts built LATER — so subscribing never
   * force-instantiates a project, yet a project's first API touch makes its
   * events flow to already-open workspace streams. Returns an unsubscribe.
   */
  onContextBuilt(listener: (ctx: ProjectContext) => void): () => void {
    this.builtListeners.add(listener);
    return () => this.builtListeners.delete(listener);
  }

  /**
   * Subscribe at the earliest RunStore lifecycle point: immediately after a
   * lazy project's store opens and before its manager can recover runs. This
   * stays generic so backend-specific observers do not leak into the context
   * map. Returns an unsubscribe.
   */
  onStoreCreated(listener: (store: RunStore) => void): () => void {
    this.storeListeners.add(listener);
    return () => this.storeListeners.delete(listener);
  }

  /** A listener throwing must never fail the build (its store is usable). */
  private notifyStoreCreated(store: RunStore): void {
    for (const listener of [...this.storeListeners]) {
      try {
        listener(store);
      } catch {
        // subscriber's problem — context construction can continue
      }
    }
  }

  /** A listener throwing must never fail the build (its context is fine). */
  private notifyBuilt(ctx: ProjectContext): void {
    for (const listener of [...this.builtListeners]) {
      try {
        listener(ctx);
      } catch {
        // subscriber's problem — the build succeeded
      }
    }
  }

  /** Already-built context, without triggering a build. */
  peek(projectId: string): ProjectContext | undefined {
    return this.contexts.get(projectId);
  }

  /** Ids of every built context (dispose bookkeeping, shutdown flush). */
  ids(): string[] {
    return [...this.contexts.keys()];
  }

  /**
   * Tear down one project's context (project removal): the manager stops
   * making moves on its own (`RunManager.dispose()` — usage-sampler
   * unsubscribe, timers, queued state) and the store is closed — index
   * flushed to disk, every event-bus subscriber detached. Returns false when
   * nothing was built for `projectId`.
   */
  dispose(projectId: string): boolean {
    const ctx = this.contexts.get(projectId);
    if (!ctx) return false;
    this.contexts.delete(projectId);
    teardown(ctx);
    return true;
  }

  /** Tear down every built context (process shutdown). */
  disposeAll(): void {
    for (const id of this.ids()) this.dispose(id);
  }

  private async build(projectId: string): Promise<ProjectContext> {
    const projects = await this.deps.listProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new ProjectContextError('unknown-project', projectId);
    if (project.status === 'missing') throw new ProjectContextError('missing-root', projectId);

    const dataDir = join(project.root, '.ai/cezar');
    // keepLive + recover() (#367), same as serveCommand: runs that were live
    // when this project's context last existed are re-queued or resumed.
    const store = RunStore.open(dataDir, { keepLive: true });
    const automationStore = this.deps.automationStore?.(project.id, project.root)
      ?? AutomationStore.open(dataDir);
    reconcileAutomationReceipts(automationStore, store);
    this.notifyStoreCreated(store);
    const manager = new RunManager(store, project.root, { semaphore: this.semaphore });
    try {
      const launchKey = ensureLaunchKey(dataDir);
      // Startup reconcile (spec 006) + count-based retention (#483) — the same
      // best-effort sweeps serveCommand runs for the boot project, gated on the
      // root actually being a git repo.
      if (await getRepoInfo(project.root)) {
        await pruneOrphans(project.root, new Set(store.listRuns().map((r) => r.id))).catch(
          () => [] as string[],
        );
        const keep = await resolveWorktreeRetention(project.root).catch(
          () => DEFAULT_WORKTREE_RETENTION,
        );
        await reclaimWorktrees(project.root, store, keep).catch(() => [] as string[]);
      }
      await manager.recover();
      // Which repository this project IS (#945), so the referenced tier stops adopting another
      // repo's PR/issue as a task's subject. Fire-and-forget on purpose — it costs a `gh` spawn
      // and building a context must not wait on the network. `project.root` is already realpath'd.
      //
      // Armed only once the build has SUCCEEDED. Arming beside `RunStore.open` would outlive a
      // failed build: the promise still resolves after `teardown` flushed the index and detached
      // every listener, and a healed record would then `touch()` a store whose lifecycle had
      // ended — scheduling a `runs.json` write from a context nobody owns any more.
      armRepoHandle(store, project.root);
      return { id: project.id, root: project.root, dataDir, store, manager, automationStore, launchKey };
    } catch (err) {
      // A failed build must not leak the half-built context's subscriptions.
      teardown({ store, manager });
      throw err;
    }
  }
}

/** Shared teardown for built and half-built contexts. */
function teardown(ctx: { store: RunStore; manager: RunManager }): void {
  ctx.manager.dispose();
  ctx.store.flush();
  ctx.store.removeAllListeners();
}
