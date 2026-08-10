import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_MONITORING_WAKE_MINUTES, loadWorkspaceConfig } from './config.ts';

/**
 * Workspace-wide resource governance (spec 2026-07-20-multi-project-workspace,
 * "Resource governance", step 2.5): `maxParallel` and `memoryLimitMb` protect
 * the *host*, not a repo, so they live in `~/.cezar/config.json` `resources`
 * and are enforced by ONE shared object across every `RunManager` — the boot
 * path constructs a single `WorkspaceSemaphore` and threads it through
 * `ProjectContexts` and the boot manager.
 *
 * Two jobs, deliberately fused because they cache the same file:
 *
 * 1. **Parallel cap** — `busy()` sums every registered manager's held slots;
 *    a manager's `pump()` starts queued runs only while `busy() <
 *    maxParallel()`. Slot accounting stays inside each manager (its
 *    `active + starting − waiting` count), which is what carries the #347
 *    exemption verbatim: a `waiting` run holds no slot, and a message into a
 *    waiting run resumes it immediately even when that momentarily exceeds
 *    the cap — a resume must never wait on other projects' runs.
 * 2. **Cached resource config** — `maxParallel()`/`memoryLimitMb()` answer
 *    from an in-memory snapshot, NOT the file: the memory guard ticks ~every
 *    2 s per manager, and N projects re-reading `~/.cezar/config.json` every
 *    tick is exactly what the spec forbids. `refresh()` is the single cache
 *    hook: boot calls it once, and `PUT /api/workspace/config` (step 2.7)
 *    calls it after a write — it re-reads the file and pumps every manager so
 *    a raised cap starts queued runs without a restart.
 *
 * Per-repo legacy `maxParallel`/`memoryLimitMb` keys are ignored by
 * enforcement post-migration (`loadConfig` still parses them for old files;
 * nothing consults them here).
 */

/** The cached `resources` slice run enforcement consults. */
export interface WorkspaceResourceLimits {
  /** Workspace-wide cap on concurrently *running* agent runs. */
  maxParallel: number;
  /** Durable monitoring sessions that do not consume active-task capacity. */
  maxMonitoringSessions?: number;
  /** Automatic monitoring re-check cadence in minutes. Default ON at
   *  `DEFAULT_MONITORING_WAKE_MINUTES`; explicit `null` means stay parked; absent means
   *  "this loader predates the key" and reads as the default. */
  monitoringWakeIntervalMinutes?: number | null;
  /** Resume a run stopped by a provider usage limit when that limit resets. Default ON. */
  autoResumeOnUsageLimit?: boolean;
  /** Per-task process-tree memory ceiling in MiB; null = no limit. */
  memoryLimitMb: number | null;
  /**
   * Per-project concurrency ceilings, keyed by realpath-normalized project
   * root (the registry stores normalized `root`). A root absent from the map
   * inherits the workspace `maxParallel`. Optional so older `load` stubs that
   * only return the resource slice keep working — an absent map means "no
   * project has an override", i.e. every project inherits.
   */
  projectLimits?: ReadonlyMap<string, number>;
}

/** Realpath-normalize a root the same way the registry does
 *  (`workspace/projects.ts` `normalizeRoot`), but synchronously — this answers
 *  a manager's hot-path lookup and must not `await`. A path that cannot be
 *  realpath'd degrades to `resolve()`, matching the registry's own fallback. */
function normalizeRootSync(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * The two kinds of usage-limit hold an account can be under, kept apart because they bind
 * different work (spec 2026-08-03-auto-resume-after-usage-limit):
 *
 *  - `deadline` — a run is parked on a reset instant that has not arrived. The window is known to
 *    be shut, so this blocks EVERYTHING on that account, resumes included.
 *  - `inFlight` — a resume is running right now, re-testing the window. Nothing is proven yet, so
 *    this blocks fresh work but NOT other resumes: a resume blocked by a resume is the deadlock
 *    that stopped a live workspace dead.
 */
export interface AccountHolds {
  deadline: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
}

/** One manager's seam into the shared counter. */
export interface SemaphoreParticipant {
  /** Slots this manager currently holds. The #347 exemption lives in the
   *  participant's own accounting: `waiting` runs are already subtracted. */
  busySlots(): number;
  /** Kick the manager's queue — capacity may have appeared. Awaited by
   *  `release()` so the manager taking a freed slot has registered it before
   *  the next participant evaluates capacity. */
  pump(): void | Promise<void>;
  /** Epoch ms of this manager's oldest queued run, or null when its queue is
   *  empty — `release()`'s ordering key, so a freed slot goes to the
   *  workspace's longest-waiting run instead of whichever manager happens to
   *  have registered first. */
  oldestQueuedAt(): number | null;
  /**
   * Agent accounts this participant is holding, by KIND (spec
   * 2026-08-03-auto-resume-after-usage-limit, `RunManager.accountHolds`).
   *
   * Workspace-scoped for the same reason the parallel cap is: a limit closes an ACCOUNT, and one
   * account can be driving tasks in several projects at once. Optional so a stub participant —
   * and any caller that predates the hold — keeps working; absent simply holds nothing.
   */
  accountHolds?(): AccountHolds;
}

const DEFAULT_LIMITS: WorkspaceResourceLimits = {
  maxParallel: 2,
  maxMonitoringSessions: 2,
  monitoringWakeIntervalMinutes: DEFAULT_MONITORING_WAKE_MINUTES,
  autoResumeOnUsageLimit: true,
  memoryLimitMb: null,
};

/** Production loader: the `resources` slice of `~/.cezar/config.json`
 *  (schema-defaulted, so a missing/corrupt file yields the zero-config
 *  2 parallel / 2 monitoring / 5-minute wake / no memory cap),
 *  plus the per-project `maxParallel` overrides built into a root→limit map.
 *  The registry `root` is already realpath-normalized (`registerProject`), so
 *  the keys match `normalizeRootSync`'s output at lookup time. */
async function loadResourceLimits(): Promise<WorkspaceResourceLimits> {
  const { resources, projects } = await loadWorkspaceConfig();
  const projectLimits = new Map<string, number>();
  for (const project of projects) {
    if (typeof project.maxParallel === 'number') projectLimits.set(project.root, project.maxParallel);
  }
  return {
    maxParallel: resources.maxParallel,
    maxMonitoringSessions: resources.maxMonitoringSessions,
    monitoringWakeIntervalMinutes: resources.monitoringWakeIntervalMinutes,
    autoResumeOnUsageLimit: resources.autoResumeOnUsageLimit,
    memoryLimitMb: resources.memoryLimitMb,
    projectLimits,
  };
}

export interface WorkspaceSemaphoreOptions {
  /** Snapshot source for `refresh()` — tests inject a stub; production keeps
   *  the `~/.cezar/config.json` reader. */
  load?: () => Promise<WorkspaceResourceLimits>;
  /** Starting cache, before any `refresh()` — defaults to the workspace
   *  schema's own defaults (`maxParallel: 2`, no memory limit), so a manager
   *  constructed without boot wiring behaves like a fresh workspace. */
  initial?: Partial<WorkspaceResourceLimits>;
}

export class WorkspaceSemaphore {
  private readonly participants = new Set<SemaphoreParticipant>();
  private readonly load: () => Promise<WorkspaceResourceLimits>;
  private limits: WorkspaceResourceLimits;
  /** A `release()` sweep is in flight — see `pendingRelease`. */
  private broadcasting = false;
  /** A slot freed DURING a sweep. The in-flight sweep may already have pumped
   *  the manager that should get it, so re-run rather than drop the wakeup. */
  private pendingRelease = false;

  constructor(options: WorkspaceSemaphoreOptions = {}) {
    this.load = options.load ?? loadResourceLimits;
    this.limits = { ...DEFAULT_LIMITS, ...options.initial };
  }

  /** Join the shared counter. Returns the unregister handle — the manager's
   *  `dispose()` must call it so a torn-down project stops counting. */
  register(participant: SemaphoreParticipant): () => void {
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  /** Slots held across EVERY registered manager (waiting runs excluded by
   *  each participant — the #347 rule). */
  busy(): number {
    let total = 0;
    for (const participant of this.participants) total += participant.busySlots();
    return total;
  }

  /** Cached workspace-wide parallel cap. */
  maxParallel(): number {
    return this.limits.maxParallel;
  }

  maxMonitoringSessions(): number {
    return this.limits.maxMonitoringSessions ?? 2;
  }

  /** Cadence for automatic monitoring re-checks, or null when the operator chose "park
   *  until resumed". Deliberately NOT `?? DEFAULT`: `null` is a real user choice and
   *  `null ?? 5` would silently override it (#810). Only an ABSENT key — an older `load`
   *  stub, a partial `initial` — falls back to the shipped default. */
  monitoringWakeIntervalMinutes(): number | null {
    const configured = this.limits.monitoringWakeIntervalMinutes;
    return configured === undefined ? DEFAULT_MONITORING_WAKE_MINUTES : configured;
  }

  /** Whether a usage-limit stop schedules its own resume. Absent (an older `load` stub, a config
   *  written before the key existed) reads as ON — the shipped default. */
  autoResumeOnUsageLimit(): boolean {
    return this.limits.autoResumeOnUsageLimit ?? true;
  }

  /** Cached per-task memory ceiling (MiB), or null for no limit. */
  memoryLimitMb(): number | null {
    return this.limits.memoryLimitMb;
  }

  /**
   * Every agent account held across the WHOLE workspace, by kind — the union of what each manager
   * reports (spec 2026-08-03-auto-resume-after-usage-limit). A `pump()` consults this before
   * starting a queued run, so a limit hit in one project also stops the same account being walked
   * into the wall from another.
   *
   * Asked live rather than cached: the underlying answer is derived from run records that change
   * on every schedule, resume and cancel, and a stale snapshot here would either stall a queue
   * whose window has reopened or leak a stampede through one that has not.
   */
  accountHolds(): AccountHolds {
    const deadline = new Set<string>();
    const inFlight = new Set<string>();
    for (const participant of this.participants) {
      const holds = participant.accountHolds?.();
      if (!holds) continue;
      for (const key of holds.deadline) deadline.add(key);
      for (const key of holds.inFlight) inFlight.add(key);
    }
    return { deadline, inFlight };
  }

  /**
   * A slot came free somewhere in the workspace: pump EVERY manager,
   * longest-waiting-queue first.
   *
   * This is the counterpart to `busy()` being workspace-wide. A `RunManager`
   * only ever pumps itself, so before this existed a freed slot reached
   * exactly one project's queue: a run queued in project B stayed `queued`
   * while project A's runs came and went, until B happened to start or finish
   * a run of its own (or someone saved the workspace config). Every
   * slot-freeing transition — a run settling, a session parking at `waiting`
   * — routes here instead.
   *
   * Pumps are awaited in turn so the manager that takes the slot has it
   * counted (`starting`) before the next manager evaluates capacity — two
   * managers pumping concurrently could both read the same free slot and
   * overshoot `maxParallel`. Ordering is best-effort fairness, not a global
   * FIFO gate: a manager whose head-of-queue can't start (non-git root,
   * spec 006 degradation) must never block the rest of the workspace.
   */
  async release(): Promise<void> {
    if (this.broadcasting) {
      this.pendingRelease = true;
      return;
    }
    this.broadcasting = true;
    try {
      do {
        this.pendingRelease = false;
        const ordered = [...this.participants]
          .map((participant) => ({
            participant,
            // Empty queues sort last — they have nothing to claim the slot with.
            since: participant.oldestQueuedAt() ?? Number.MAX_SAFE_INTEGER,
          }))
          .sort((a, b) => a.since - b.since);
        for (const { participant } of ordered) await participant.pump();
      } while (this.pendingRelease);
    } finally {
      this.broadcasting = false;
    }
  }

  /**
   * The effective per-project concurrency cap for a manager's repo root: the
   * project's own `maxParallel` if set in the registry, else the workspace cap
   * (`maxParallel()`). Answered from the cached snapshot — the class's
   * no-per-tick-file-read invariant is preserved; the only syscall is a
   * `realpathSync` to key the lookup the same way the registry normalizes
   * `root` (once per `pump()`, alongside the existing `getRepoInfo` stat). A
   * root with no registry entry (an ad-hoc run outside the registry) has no
   * override and inherits the workspace cap.
   */
  projectMaxParallel(repoRoot: string): number {
    const override = this.limits.projectLimits?.get(normalizeRootSync(repoRoot));
    return override ?? this.maxParallel();
  }

  /**
   * The workspace resource-cache hook: re-read the config and pump every
   * registered manager, so a config change takes effect without a restart.
   * Called at boot and by `PUT /api/workspace/config` (step 2.7). A failed
   * read keeps the last good cache — enforcement never degrades to unlimited
   * because the file was momentarily unreadable.
   */
  async refresh(): Promise<void> {
    try {
      this.limits = await this.load();
    } catch {
      // keep the last good snapshot
    }
    // A raised cap is capacity appearing everywhere at once — same sweep.
    await this.release();
  }
}
