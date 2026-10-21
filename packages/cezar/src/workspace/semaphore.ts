import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostUsage } from '@open-mercato/cezar-contract';
import { currentHostUsage, HOST_SAMPLE_INTERVAL_MS, HOST_SAMPLE_STALE_MS, onHostUsage } from '../core/host-usage.ts';
import { allUsage, onUsage, type ProcessUsage } from '../core/process-usage.ts';
import { agentMemoryBlock, hostReserveBlock, type HostReserve } from './host-headroom.ts';
import {
  effectiveCapacity,
  freeFromHost,
  headroomRuns,
  observedPerRun,
  stepScale,
  type ClassCounts,
  type PoolClass,
  type PoolLimits,
} from './effective-capacity.ts';
export type { ClassCounts, PoolClass, PoolLimits } from './effective-capacity.ts';
import { DEFAULT_IDLE_TIMEOUT_MINUTES, DEFAULT_MONITORING_WAKE_MINUTES, loadWorkspaceConfig } from './config.ts';

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
  /** Plain waiting/ASK session idle timeout in minutes; null/0 disables it. */
  idleTimeoutMinutes?: number | null;
  /** Automatic monitoring re-check cadence in minutes. Default ON at
   *  `DEFAULT_MONITORING_WAKE_MINUTES`; explicit `null` means stay parked; absent means
   *  "this loader predates the key" and reads as the default. */
  monitoringWakeIntervalMinutes?: number | null;
  /** Resume a run stopped by a provider usage limit when that limit resets. Default ON. */
  autoResumeOnUsageLimit?: boolean;
  /** Per-task process-tree memory ceiling in MiB; null = no limit. */
  memoryLimitMb: number | null;
  /** OS priority for agent process trees (spec 2026-10-21-host-resource-limits). Absent = normal. */
  agentCpuPriority?: AgentCpuPriority;
  /** Host headroom to keep free before starting a NEW run. Absent = off. */
  hostReserve?: HostReserve;
  /** Ceiling on the summed RSS of all agent trees before a NEW run starts. Absent/null = off. */
  totalAgentMemoryMb?: number | null;
  /** Own pool for dispatched `implement` children; absent/null = share `maxParallel`
   *  (spec 2026-10-21-work-limits). */
  maxSubagents?: number | null;
  /** Own pool for dispatched `review` children; absent/null = share `maxParallel`. */
  maxReviewers?: number | null;
  /** Scale every pool down to what free memory and CPU can carry. Default off. */
  autoScale?: boolean;
  /**
   * Per-project concurrency ceilings, keyed by realpath-normalized project
   * root (the registry stores normalized `root`). A root absent from the map
   * inherits the workspace `maxParallel`. Optional so older `load` stubs that
   * only return the resource slice keep working — an absent map means "no
   * project has an override", i.e. every project inherits.
   */
  projectLimits?: ReadonlyMap<string, number>;
}

export type AgentCpuPriority = 'normal' | 'low' | 'idle';

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
  /** The same slots split by pool. Optional so stubs keep working: absent reads as all `main`. */
  busyByClass?(): ClassCounts;
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
  /** Runs a restart would interrupt (queued, waiting or running) — the self-update dialog's
   *  warning. Optional for stubs; absent counts none. */
  activeRuns?(): number;
}

const DEFAULT_LIMITS: WorkspaceResourceLimits = {
  maxParallel: 2,
  maxMonitoringSessions: 2,
  idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
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
    idleTimeoutMinutes: resources.idleTimeoutMinutes,
    monitoringWakeIntervalMinutes: resources.monitoringWakeIntervalMinutes,
    autoResumeOnUsageLimit: resources.autoResumeOnUsageLimit,
    memoryLimitMb: resources.memoryLimitMb,
    maxSubagents: resources.maxSubagents,
    maxReviewers: resources.maxReviewers,
    autoScale: resources.autoScale,
    agentCpuPriority: resources.agentCpuPriority,
    hostReserve: resources.hostReserve,
    totalAgentMemoryMb: resources.totalAgentMemoryMb,
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
  /** Telemetry seams for the host-headroom gate; tests inject fakes, production reads the
   *  process-wide samplers. */
  host?: {
    current(): HostUsage | undefined;
    subscribe(listener: () => void): () => void;
    agentUsage(): Record<string, Pick<ProcessUsage, 'rssBytes'> & { cpuPct?: number }>;
    subscribeAgents(listener: () => void): () => void;
    now(): number;
  };
}

const defaultHost: NonNullable<WorkspaceSemaphoreOptions['host']> = {
  current: currentHostUsage,
  subscribe: (listener) => onHostUsage(() => listener()),
  agentUsage: allUsage,
  subscribeAgents: (listener) => onUsage(() => listener()),
  now: () => Date.now(),
};

export class WorkspaceSemaphore {
  private readonly participants = new Set<SemaphoreParticipant>();
  private readonly load: () => Promise<WorkspaceResourceLimits>;
  private limits: WorkspaceResourceLimits;
  /** A `release()` sweep is in flight — see `pendingRelease`. */
  private broadcasting = false;
  /** A slot freed DURING a sweep. The in-flight sweep may already have pumped
   *  the manager that should get it, so re-run rather than drop the wakeup. */
  private pendingRelease = false;
  private readonly host: NonNullable<WorkspaceSemaphoreOptions['host']>;
  private offHost: (() => void) | null = null;
  private offAgents: (() => void) | null = null;
  /** Telemetry ticks seen, and the tick of the last gated start: one gated start per tick, so a
   *  burst of queued runs cannot all pass the same stale reading (spec 2026-10-21). */
  private ticks = 0;
  private startTick = -1;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  /** The gate turned a start away; the next tick re-pumps. */
  private hostDeferred = false;
  /** autoScale's current effective limits (null = use the configured ones) and the calm-sample
   *  counters that gate a raise. */
  private scaled: PoolLimits | null = null;
  private scaledAt = 0;
  /** Headroom (runs) behind `scaled`; undefined when unreadable. */
  private room: number | undefined;
  private calm = { main: 0, subagent: 0, review: 0 };

  constructor(options: WorkspaceSemaphoreOptions = {}) {
    this.load = options.load ?? loadResourceLimits;
    this.host = options.host ?? defaultHost;
    this.limits = { ...DEFAULT_LIMITS, ...options.initial };
    this.syncHostGate();
  }

  agentCpuPriority(): AgentCpuPriority {
    return this.limits.agentCpuPriority ?? 'normal';
  }

  private reserve(): HostReserve | null {
    const r = this.limits.hostReserve;
    return r && ((r.memoryMb ?? 0) > 0 || (r.cpuPct ?? 0) > 0) ? r : null;
  }

  private totalAgentMemoryMb(): number | null {
    const mb = this.limits.totalAgentMemoryMb;
    return mb && mb > 0 ? mb : null;
  }

  /** Sample the host only while a guard is configured (zero cost by default). */
  private syncHostGate(): void {
    const onTick = () => {
      // Host and agent samplers both fire every ~2 s: count ONE tick (and one autoScale step) per
      // sample period so the brake and the calm counters do not run at double rate.
      const at = this.host.now();
      let raised = false;
      if (at - this.lastTickAt >= HOST_SAMPLE_INTERVAL_MS / 2) {
        this.ticks += 1;
        this.lastTickAt = at;
        raised = this.rescale();
      }
      if (!this.hostDeferred && !raised) return;
      this.hostDeferred = false;
      void this.release(); // pressure may have cleared, or a pool grew
    };
    const wantHost = this.reserve() !== null || this.autoScale();
    if (wantHost && !this.offHost) this.offHost = this.host.subscribe(onTick);
    else if (!wantHost && this.offHost) {
      this.offHost();
      this.offHost = null;
    }
    if (!this.autoScale()) this.scaled = null;
    else this.rescale(true);
    if (this.totalAgentMemoryMb() !== null && !this.offAgents) this.offAgents = this.host.subscribeAgents(onTick);
    else if (this.totalAgentMemoryMb() === null && this.offAgents) {
      this.offAgents();
      this.offAgents = null;
    }
    if (!wantHost && this.totalAgentMemoryMb() === null) {
      this.hostDeferred = false;
      this.ticks = 0;
      this.startTick = -1;
      this.lastTickAt = Number.NEGATIVE_INFINITY;
    }
  }

  /** Stop sampling and forget gate state — teardown and tests. */
  dispose(): void {
    this.offHost?.();
    this.offAgents?.();
    this.offHost = null;
    this.offAgents = null;
    this.hostDeferred = false;
    this.ticks = 0;
    this.startTick = -1;
    this.lastTickAt = Number.NEGATIVE_INFINITY;
    this.scaled = null;
  }

  /** Why a NEW run must wait for the host, or null (spec 2026-10-21-host-resource-limits).
   *  Fails open on a missing/stale sample; an idle workspace always admits one run, so a queue
   *  can never dead-end behind a machine that is busy with something else. */
  hostBlock(): string | null {
    const reserve = this.reserve();
    const totalMb = this.totalAgentMemoryMb();
    const braking = this.brakeApplies();
    if (!reserve && totalMb === null && !braking) return null;
    if (this.busy() === 0) return null;
    // One start per sample period — including before the first sample exists, so a startup burst
    // cannot all pass the fail-open. A sampler silent for a stale window lifts the brake (fail open).
    if (braking && this.ticks === this.startTick && this.host.now() - this.lastStartAt <= HOST_SAMPLE_STALE_MS) {
      return 'waiting for a fresh reading after the last start';
    }
    let usage = this.host.current();
    if (usage && this.host.now() - Date.parse(usage.sampledAt) > HOST_SAMPLE_STALE_MS) usage = undefined;
    return (
      (reserve ? hostReserveBlock(reserve, usage) : null) ?? agentMemoryBlock(totalMb, this.host.agentUsage())
    );
  }

  /** Pure capacity predicate for `pump()`. */
  hostAdmits(): boolean {
    return this.hostBlock() === null;
  }

  /** `pump()` stopped with runs still queued: if the host is why, the next tick re-pumps. */
  noteHostDeferral(): void {
    if (this.hostBlock() !== null) this.hostDeferred = true;
  }

  /** The one-start-per-tick brake: always with a reserve/total guard; with autoScale alone only
   *  once the computed room is nearly gone, so a roomy machine still fills its pools at once. */
  private brakeApplies(): boolean {
    if (this.reserve() || this.totalAgentMemoryMb() !== null) return true;
    return this.autoScale() && this.scaled !== null && this.room !== undefined && this.room < 2;
  }

  /** `pump()` just dequeued a run through the gate. */
  noteGatedStart(): void {
    if (!this.brakeApplies()) return;
    this.startTick = this.ticks;
    this.lastStartAt = this.host.now();
  }

  // ---- pools (spec 2026-10-21-work-limits) ----

  /** True once a kind has a pool of its own; until then nothing needs classifying. */
  hasSeparatePools(): boolean {
    return !!this.limits.maxSubagents || !!this.limits.maxReviewers;
  }

  autoScale(): boolean {
    return this.limits.autoScale === true;
  }

  private configuredLimits(): PoolLimits {
    return {
      main: this.limits.maxParallel,
      subagent: this.limits.maxSubagents ?? null,
      review: this.limits.maxReviewers ?? null,
    };
  }

  /** Which pool a run draws from. A kind only gets its own pool when that pool is configured;
   *  otherwise it counts against `maxParallel` exactly as before. */
  classify(dispatch: { parentRunId?: string; kind?: string } | undefined): PoolClass {
    if (!dispatch?.parentRunId) return 'main';
    if (dispatch.kind === 'review') return this.limits.maxReviewers ? 'review' : 'main';
    return this.limits.maxSubagents ? 'subagent' : 'main';
  }

  /** Held slots by pool, across every manager. A stub without a split is all `main`. */
  busyBy(): ClassCounts {
    const total: ClassCounts = { main: 0, subagent: 0, review: 0 };
    for (const p of this.participants) {
      const by = p.busyByClass?.() ?? { main: p.busySlots(), subagent: 0, review: 0 };
      total.main += by.main;
      total.subagent += by.subagent;
      total.review += by.review;
    }
    return total;
  }

  /**
   * The limits admission uses now, as `{main, subagent, review}` (null = that kind shares main):
   * autoScale's while its reading is fresh, else the configured ones. Public, with `freeCapacity()`,
   * for readouts and the fleet hub. A reading older than a stale window is dropped here, so
   * silent telemetry can never leave a lowered limit stuck.
   */
  effectiveLimits(): PoolLimits {
    if (this.scaled && this.host.now() - this.scaledAt <= HOST_SAMPLE_STALE_MS) return this.scaled;
    return this.configuredLimits();
  }

  /** Limit of one pool; a pool without its own limit is the main pool. */
  limitOf(pool: PoolClass): number {
    const eff = this.effectiveLimits();
    return (pool === 'main' ? eff.main : eff[pool]) ?? eff.main;
  }

  /** Room in the pool a run would draw from (per-project cap is the manager's own business). */
  poolHasRoom(pool: PoolClass): boolean {
    return this.busyBy()[pool] < this.limitOf(pool);
  }

  /** Free slots per pool (effective limit - busy, >= 0). A kind without its own pool reports the
   *  main pool's room, because that is what it would take. */
  freeCapacity(): ClassCounts {
    const busy = this.busyBy();
    const room = (pool: PoolClass) => Math.max(0, this.limitOf(pool) - busy[pool]);
    const main = room('main');
    return { main, subagent: this.limits.maxSubagents ? room('subagent') : main, review: this.limits.maxReviewers ? room('review') : main };
  }

  /** Recompute autoScale from the newest host sample. Returns true when any pool grew.
   *  Fails open: no fresh sample or nothing readable means the configured limits. */
  private rescale(reset = false): boolean {
    if (!this.autoScale()) return false;
    let usage = this.host.current();
    if (usage && this.host.now() - Date.parse(usage.sampledAt) > HOST_SAMPLE_STALE_MS) usage = undefined;
    const configured = this.configuredLimits();
    const input = usage
      ? {
          configured,
          busy: this.busyBy(),
          ...freeFromHost(usage, this.limits.hostReserve?.memoryMb ?? null),
          ...observedPerRun(this.host.agentUsage()),
        }
      : undefined;
    if (!input || headroomRuns(input) === undefined) {
      // Nothing readable: back to the configured limits at once, never a slow ramp.
      const wasLower = this.scaled !== null;
      this.scaled = null;
      this.room = undefined;
      this.calm = { main: 0, subagent: 0, review: 0 };
      return wasLower;
    }
    const next = effectiveCapacity(input);
    this.room = headroomRuns(input);
    this.scaledAt = this.host.now();
    if (reset) {
      // A config change starts from the current headroom, not from the old scaled baseline.
      this.scaled = next;
      this.calm = { main: 0, subagent: 0, review: 0 };
      return false;
    }
    const prev = this.scaled ?? configured;
    let grew = false;
    const step = (pool: PoolClass): number | null => {
      const target = pool === 'main' ? next.main : next[pool];
      const before = pool === 'main' ? prev.main : prev[pool];
      if (target === null || before === null) return target;
      const r = stepScale(before, target, this.calm[pool]);
      this.calm[pool] = r.calm;
      if (r.value > before) grew = true;
      return r.value;
    };
    this.scaled = { main: step('main') as number, subagent: step('subagent'), review: step('review') };
    return grew;
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

  /** Runs a restart would interrupt, across every registered project — not just the boot one. */
  activeRuns(): number {
    let total = 0;
    for (const participant of this.participants) total += participant.activeRuns?.() ?? 0;
    return total;
  }

  /** No slot held and nothing queued anywhere in the workspace — when "update when idle" may
   *  restart. Waiting runs do not count (#347): they are parked on the user, and boot resumes them. */
  idle(): boolean {
    for (const participant of this.participants) {
      if (participant.busySlots() > 0 || participant.oldestQueuedAt() !== null) return false;
    }
    return true;
  }

  /** Cached workspace-wide parallel cap. */
  maxParallel(): number {
    return this.limits.maxParallel;
  }

  maxMonitoringSessions(): number {
    return this.limits.maxMonitoringSessions ?? 2;
  }

  idleTimeoutMinutes(): number | null {
    return this.limits.idleTimeoutMinutes === undefined
      ? DEFAULT_IDLE_TIMEOUT_MINUTES
      : this.limits.idleTimeoutMinutes;
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
      this.syncHostGate();
    } catch {
      // keep the last good snapshot
    }
    // A raised cap is capacity appearing everywhere at once — same sweep.
    await this.release();
  }
}
