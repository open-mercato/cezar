/**
 * Cross-task waits — the workspace-level WAIT RESOLVER (spec
 * `.ai/specs/2026-10-05-cross-task-waits.md`).
 *
 * A running task A declares it waits for task B — in its own project or another registered one —
 * and parks without a compute slot (the engine half: `turnParkReason` in `workflows/run.ts`). This
 * module owns everything that happens BETWEEN projects: validating a declaration, keeping a reverse
 * index `target → edges`, and resolving each edge exactly once, when
 *
 *  - its target settles (`done | review | failed | cancelled`)   → `settled`
 *  - its target run is deleted                                    → `target-deleted`
 *  - its target's project is removed from the registry           → `target-unavailable`
 *  - its deadline passes (mandatory, default 24 h)                → `timed-out`
 *  - the user stops it                                            → `cancelled`
 *  - the WAITER itself settles or is deleted                      → `waiter-ended` (no delivery)
 *
 * and delivering one message into the waiter through its own manager's ladder
 * (`RunManager.deliverWaitNotice`). Every one of those exits is engine-fired; none needs a human.
 *
 * The edges live on the WAITER's run record (`RunRecord.waits`), so a restart loses nothing: the
 * in-memory index is rebuilt from records whenever a project context is built (`contextBuilt` —
 * the catch-up), and the boot sweep builds every project that still holds a pending edge.
 *
 * Why the catch-up is complete: a project's runs only execute inside a built context, and contexts
 * are disposed only on project removal or process exit. So a target settles only while its context
 * is built (the live `'settled'` event), and a waiter needs waking only while ITS context is built;
 * if it was not built when the target settled, the catch-up at its build delivers the outcome.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  WAIT_DEFAULT_TIMEOUT_MINUTES,
  WAIT_MAX_HISTORY,
  WAIT_MAX_PENDING,
  type WaitDeclareResponse,
  type WaitEdge,
  type WaitInput,
  type WaitOrigin,
  type WaitOutcome,
  type WaitState,
} from '@open-mercato/cezar-contract';
import { childSettleReport, isTerminalStatus, usd } from '../dispatch/engine.ts';
import { readRunIndexFromDisk } from '../runs/run-index.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';

/** The slice of a project context the resolver needs. The manager half is one method, so the
 *  resolver can be driven in tests without a real `RunManager`. */
export interface WaitProjectContext {
  id: string;
  store: RunStore;
  manager: { deliverWaitNotice(runId: string, text: string): boolean };
}

/** A typed refusal the route layer maps straight onto a status. */
export interface WaitRefusal {
  status: 400 | 404 | 409;
  error: string;
}

/** A refusal, told apart from a run record by its NUMERIC status (a run's status is a string). */
export function isWaitRefusal(value: unknown): value is WaitRefusal {
  return typeof (value as { status?: unknown } | null)?.status === 'number';
}

/** The `create` half of a declaration (Phase 2) — injected so this module stays free of the
 *  manager's task-creation machinery. Answers the created run, or a refusal. */
export type WaitCreateTarget = (
  waiter: { projectId: string; run: RunRecord },
  target: WaitProjectContext,
  input: Extract<WaitInput, { create: unknown }>['create'],
) => Promise<{ run: RunRecord; budgetUsd?: number } | WaitRefusal>;

export interface WaitResolverDeps {
  /** Map an id as a caller spells it onto the id the resolver keys projects by: `default` and the
   *  boot project's registry id both name the boot context. */
  canonical(projectId: string): Promise<string>;
  /** An already-built context (the boot one included), or undefined. */
  peek(projectId: string): WaitProjectContext | undefined;
  /** Build (or return) a project's context. Throws for unknown projects and missing roots. */
  build(projectId: string): Promise<WaitProjectContext>;
  /** The registry, for the boot sweep. */
  listProjects(): Promise<ReadonlyArray<{ id: string; root: string; status: string }>>;
  /** Phase 2's create path. Absent → a `create` declaration is refused. */
  createTarget?: WaitCreateTarget;
  now?: () => number;
}

/** Node's timers overflow past ~24.8 days; a deadline further out is re-armed in hops. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const key = (projectId: string, runId: string): string => `${projectId}\u0000${runId}`;

interface IndexedEdge {
  waiterProjectId: string;
  waiterRunId: string;
  edgeId: string;
  targetKey: string;
  deadline: number;
}

/** The short, stable way a run is named in messages: `<project>/<id8>`. */
export function waitRef(projectId: string, runId: string): string {
  return `${projectId}/${runId.slice(0, 8)}`;
}

/** What the route answers when the target had already settled at declare time. */
export function waitOutcomeOf(projectId: string, target: RunRecord): WaitOutcome {
  return {
    target: { projectId, runId: target.id },
    title: target.titleSummary ?? target.title,
    status: target.status,
    ...(target.branch ? { branch: target.branch } : {}),
    ...(target.pullRequestUrl ? { prUrl: target.pullRequestUrl } : {}),
    ...(target.costUsd !== undefined ? { costUsd: target.costUsd } : {}),
    ...(target.error ? { error: target.error } : {}),
    ...(target.dispatch?.report ? { report: target.dispatch.report } : {}),
  };
}

/**
 * The message a waiter receives when a target SETTLED: the dispatch report formatter (status,
 * result, evidence, errors, branch, cost, diff) — the shapes match, and a waiter reads a target's
 * outcome exactly as a commander reads a child's — plus the PR URL, which a dispatch child never
 * has but an independent task usually does.
 */
export function settledMessage(projectId: string, target: RunRecord, stillPending: number): string {
  const { text } = childSettleReport(target);
  const pr = target.pullRequestUrl ? ` PR: ${target.pullRequestUrl}.` : '';
  return `The task you were waiting for (${waitRef(projectId, target.id)}) has settled — ${target.status}. ${text}.${pr}${stillWaiting(stillPending)}`;
}

function stillWaiting(pending: number): string {
  if (pending === 0) return ' You are no longer waiting for anything; carry on.';
  return ` You are still waiting for ${pending} other task${pending === 1 ? '' : 's'} — when you have nothing else to do, end your turn and cezar wakes you again.`;
}

/** The message for every non-settle resolution, by state. */
function resolutionMessage(edge: WaitEdge, state: WaitState, stillPending: number, extra: { status?: string; minutes?: number }): string | undefined {
  const name = `"${edge.targetTitle}" (${waitRef(edge.target.projectId, edge.target.runId)})`;
  switch (state) {
    case 'target-deleted':
      return `The task you waited for, ${name}, was deleted — it will not settle.${stillWaiting(stillPending)}`;
    case 'target-unavailable':
      return `The task you waited for, ${name}, is unavailable: project ${edge.target.projectId} was removed or its folder is missing.${stillWaiting(stillPending)}`;
    case 'timed-out':
      return `Your wait for ${name} timed out after ${extra.minutes ?? '?'} min; the target is still ${extra.status ?? 'unknown'}. Decide whether to wait again (cez task wait), carry on without it, or stop and report.${stillWaiting(stillPending)}`;
    case 'cancelled':
      return `The user stopped your wait for ${name}.${stillWaiting(stillPending)}`;
    default:
      return undefined;
  }
}

export class WaitResolver {
  private readonly edges = new Map<string, IndexedEdge>();
  private readonly byTarget = new Map<string, Set<string>>();
  private readonly byWaiter = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Per-project store subscriptions, released on project removal and on dispose. */
  private readonly attached = new Map<string, { store: RunStore; off: () => void }>();
  private disposed = false;

  constructor(private readonly deps: WaitResolverDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  /**
   * Listen to one project's store — wired to `ProjectContexts.onStoreCreated`, i.e. BEFORE the
   * project's manager recovers, so a target that settles during recovery is heard. Idempotent.
   */
  attachStore(projectId: string, store: RunStore): void {
    if (this.disposed) return;
    const current = this.attached.get(projectId);
    if (current?.store === store) return;
    current?.off();
    const onSettled = (runId: string) => this.onSettled(projectId, runId);
    const onDeleted = (runId: string) => this.onDeleted(projectId, runId);
    store.on('settled', onSettled);
    store.on('deleted', onDeleted);
    this.attached.set(projectId, {
      store,
      off: () => {
        store.off('settled', onSettled);
        store.off('deleted', onDeleted);
      },
    });
  }

  /**
   * The CATCH-UP, run whenever a context is built (and once for the boot context): re-index the
   * project's pending edges, resolve any whose target already settled, vanished or ran out of
   * time, resolve a settled waiter's edges as `waiter-ended`, re-evaluate edges elsewhere that
   * target this project, and make sure every target project is built so its runs progress.
   */
  contextBuilt(projectId: string): void {
    if (this.disposed) return;
    const ctx = this.deps.peek(projectId);
    if (!ctx) return;
    this.attachStore(projectId, ctx.store);
    for (const run of ctx.store.listRuns()) {
      const pending = (run.waits ?? []).filter((edge) => edge.state === 'pending');
      if (pending.length === 0) continue;
      if (isTerminalStatus(run.status)) {
        for (const edge of pending) this.writeResolution(ctx, run.id, edge.id, 'waiter-ended');
        continue;
      }
      for (const edge of pending) this.index(projectId, run.id, edge);
    }
    for (const [edgeKey, indexed] of [...this.edges]) {
      if (indexed.waiterProjectId === projectId || indexed.targetKey.startsWith(`${projectId}\u0000`)) {
        this.evaluate(edgeKey);
      }
    }
  }

  /**
   * Boot sweep: only the boot project's context is built eagerly, so a waiter in another project
   * would otherwise sit with no armed deadline until someone opened it. Reads every registered
   * project's `runs.json` read-only and builds the ones that hold a pending edge; their catch-up
   * then builds the projects they wait on.
   */
  async bootSweep(): Promise<void> {
    let projects: ReadonlyArray<{ id: string; root: string; status: string }>;
    try {
      projects = await this.deps.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      if (this.disposed) return;
      if (project.status === 'missing') continue;
      const id = await this.deps.canonical(project.id).catch(() => project.id);
      if (this.deps.peek(id)) continue;
      const runs = readRunIndexFromDisk(join(project.root, '.ai/cezar'));
      if (!runs.some((run) => run.waits?.some((edge) => edge.state === 'pending'))) continue;
      await this.ensureBuilt(id);
    }
  }

  /**
   * A project was removed from the registry — fired by the removal ROUTE, never by context
   * disposal: process shutdown disposes every context, and hooking that would cancel every
   * cross-project wait on every shutdown. Edges that target the removed project resolve
   * `target-unavailable`; the removed project's own edges die with its records.
   */
  projectRemoved(projectId: string): void {
    this.attached.get(projectId)?.off();
    this.attached.delete(projectId);
    for (const [edgeKey, indexed] of [...this.edges]) {
      if (indexed.waiterProjectId === projectId) this.unindex(edgeKey);
      else if (indexed.targetKey.startsWith(`${projectId}\u0000`)) this.resolve(edgeKey, 'target-unavailable');
    }
  }

  /** Release every timer and subscription (server shutdown, tests). Records are untouched — the
   *  edges stay pending on disk and the next process picks them up. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const { off } of this.attached.values()) off();
    this.attached.clear();
    this.edges.clear();
    this.byTarget.clear();
    this.byWaiter.clear();
  }

  // ---- declare / cancel ----------------------------------------------------------------------

  /**
   * Declare that `waiterRunId` (in `waiterProjectId`) waits for a target — or, Phase 2, create the
   * target in another project and wait for it. Answers the edge (`pending`), the target's outcome
   * when it had already settled (`settled`, nothing recorded), or a refusal.
   */
  async declare(
    waiterProjectId: string,
    waiterRunId: string,
    input: WaitInput,
    origin: WaitOrigin,
  ): Promise<WaitDeclareResponse | WaitRefusal> {
    const waiterCtx = this.deps.peek(waiterProjectId);
    const waiter = waiterCtx?.store.getRun(waiterRunId);
    if (!waiterCtx || !waiter) return { status: 404, error: `no run ${waiterRunId}` };
    if (waiter.status !== 'running' && waiter.status !== 'waiting') {
      return { status: 409, error: `run ${waiterRunId.slice(0, 8)} is ${waiter.status} — only a live task can wait` };
    }
    const pending = (waiter.waits ?? []).filter((edge) => edge.state === 'pending');
    const timeoutMinutes = input.timeoutMinutes ?? WAIT_DEFAULT_TIMEOUT_MINUTES;

    if ('create' in input) {
      if (!this.deps.createTarget) return { status: 409, error: 'creating a task in another project is not available on this cockpit' };
      if (pending.length >= WAIT_MAX_PENDING) {
        return { status: 409, error: `this task already waits for ${pending.length} tasks — the cap is ${WAIT_MAX_PENDING}; wait for one to settle first` };
      }
      const resolved = await this.resolveProject(input.create.projectId);
      if (isWaitRefusal(resolved)) return resolved;
      const created = await this.deps.createTarget({ projectId: waiterProjectId, run: waiter }, resolved, input.create);
      if (isWaitRefusal(created)) return created;
      const edge = this.record(waiterCtx, waiterRunId, resolved.id, created.run, origin, timeoutMinutes, {
        created: true,
        ...(created.budgetUsd !== undefined ? { budgetUsd: created.budgetUsd } : {}),
      });
      return { kind: 'pending', edge };
    }

    const resolvedProject = input.target.projectId
      ? await this.resolveProject(input.target.projectId)
      : waiterCtx;
    if (isWaitRefusal(resolvedProject)) return resolvedProject;
    const found = this.resolveRun(resolvedProject, input.target.runId);
    if (isWaitRefusal(found)) return found;
    const target = found;
    if (resolvedProject.id === waiterProjectId && target.id === waiterRunId) {
      return { status: 400, error: 'a task cannot wait for itself' };
    }
    const existing = pending.find((edge) => edge.target.projectId === resolvedProject.id && edge.target.runId === target.id);
    if (existing) return { kind: 'pending', edge: existing };
    if (isTerminalStatus(target.status)) return { kind: 'settled', outcome: waitOutcomeOf(resolvedProject.id, target) };
    if (pending.length >= WAIT_MAX_PENDING) {
      return { status: 409, error: `this task already waits for ${pending.length} tasks — the cap is ${WAIT_MAX_PENDING}; wait for one to settle first` };
    }
    const loop = this.cycle(key(waiterProjectId, waiterRunId), key(resolvedProject.id, target.id));
    if (loop) return { status: 409, error: `waiting would create a cycle: ${loop}` };
    const edge = this.record(waiterCtx, waiterRunId, resolvedProject.id, target, origin, timeoutMinutes);
    if (origin === 'user') {
      const text = `The user asked you to wait for "${edge.targetTitle}" (${waitRef(edge.target.projectId, edge.target.runId)}) — when you have nothing else to do, end your turn; cezar wakes you when it settles.`;
      waiterCtx.manager.deliverWaitNotice(waiterRunId, text);
    }
    return { kind: 'pending', edge };
  }

  /** "Stop waiting": resolve one pending edge as `cancelled` and tell the waiter. */
  cancel(waiterProjectId: string, waiterRunId: string, waitId: string): { edge: WaitEdge } | WaitRefusal {
    const ctx = this.deps.peek(waiterProjectId);
    const run = ctx?.store.getRun(waiterRunId);
    if (!ctx || !run) return { status: 404, error: `no run ${waiterRunId}` };
    const edge = run.waits?.find((candidate) => candidate.id === waitId);
    if (!edge) return { status: 404, error: `no wait ${waitId} on run ${waiterRunId.slice(0, 8)}` };
    if (edge.state !== 'pending') return { status: 409, error: `that wait already ended (${edge.state})` };
    const edgeKey = `${key(waiterProjectId, waiterRunId)}\u0000${waitId}`;
    if (this.edges.has(edgeKey)) this.resolve(edgeKey, 'cancelled');
    else this.writeResolution(ctx, waiterRunId, waitId, 'cancelled');
    const after = ctx.store.getRun(waiterRunId)?.waits?.find((candidate) => candidate.id === waitId);
    return { edge: after ?? { ...edge, state: 'cancelled' } };
  }

  // ---- resolution helpers -------------------------------------------------------------------

  private async resolveProject(raw: string): Promise<WaitProjectContext | WaitRefusal> {
    const id = await this.deps.canonical(raw).catch(() => raw);
    const built = this.deps.peek(id);
    if (built) {
      this.contextKnown(built);
      return built;
    }
    try {
      const ctx = await this.deps.build(id);
      this.contextKnown(ctx);
      return ctx;
    } catch (error) {
      const reason = (error as { reason?: unknown }).reason;
      if (reason === 'missing-root') return { status: 409, error: `project folder not found: ${id}` };
      return { status: 404, error: `unknown project: ${id}` };
    }
  }

  /** A context the resolver reached on its own (declare) is attached at once — the
   *  `onContextBuilt` hook fires too, but only for contexts the lazy map builds. */
  private contextKnown(ctx: WaitProjectContext): void {
    if (!this.attached.has(ctx.id)) this.contextBuilt(ctx.id);
  }

  private resolveRun(ctx: WaitProjectContext, ref: string): RunRecord | WaitRefusal {
    const exact = ctx.store.getRun(ref);
    if (exact) return exact;
    const candidates = ctx.store.listRuns().filter((run) => run.id.startsWith(ref));
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) return { status: 404, error: `no run ${ref} in project ${ctx.id}` };
    const names = candidates.slice(0, 6).map((run) => `${run.id.slice(0, 12)} "${run.titleSummary ?? run.title}"`);
    return { status: 404, error: `run id ${ref} is ambiguous in project ${ctx.id}: ${names.join(', ')} — use more characters` };
  }

  /** Would `waiter → target` close a loop? DFS from the target over every pending edge the
   *  built contexts hold; answers the loop as `a → b → … → a`, or undefined. */
  private cycle(waiterKey: string, targetKey: string): string | undefined {
    const seen = new Set<string>();
    const path: string[] = [];
    const visit = (node: string): boolean => {
      if (node === waiterKey) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      path.push(node);
      const [projectId, runId] = node.split('\u0000') as [string, string];
      const run = this.deps.peek(projectId)?.store.getRun(runId);
      for (const edge of run?.waits ?? []) {
        if (edge.state !== 'pending') continue;
        if (visit(key(edge.target.projectId, edge.target.runId))) return true;
      }
      path.pop();
      return false;
    };
    if (!visit(targetKey)) return undefined;
    const label = (node: string) => {
      const [projectId, runId] = node.split('\u0000') as [string, string];
      return waitRef(projectId, runId);
    };
    return [waiterKey, ...path, waiterKey].map(label).join(' → ');
  }

  /** Write a new pending edge onto the waiter, index it and arm its deadline. */
  private record(
    ctx: WaitProjectContext,
    waiterRunId: string,
    targetProjectId: string,
    target: RunRecord,
    origin: WaitOrigin,
    timeoutMinutes: number,
    extra: Partial<Pick<WaitEdge, 'created' | 'budgetUsd'>> = {},
  ): WaitEdge {
    const now = this.now();
    const edge: WaitEdge = {
      id: randomUUID(),
      target: { projectId: targetProjectId, runId: target.id },
      targetTitle: target.titleSummary ?? target.title,
      origin,
      ...extra,
      createdAt: new Date(now).toISOString(),
      deadline: new Date(now + timeoutMinutes * 60_000).toISOString(),
      state: 'pending',
    };
    const current = ctx.store.getRun(waiterRunId)?.waits ?? [];
    ctx.store.updateRun(waiterRunId, { waits: [...current, edge] });
    ctx.store.appendEvent(waiterRunId, {
      type: 'note',
      message: `waiting for "${edge.targetTitle}" (${waitRef(targetProjectId, target.id)})${extra.created ? ' — created by this task' : ''}, up to ${timeoutMinutes} min${origin === 'user' ? ' — asked by the user' : ''}`,
    });
    this.index(ctx.id, waiterRunId, edge);
    return edge;
  }

  private index(waiterProjectId: string, waiterRunId: string, edge: WaitEdge): void {
    const waiterKey = key(waiterProjectId, waiterRunId);
    const edgeKey = `${waiterKey}\u0000${edge.id}`;
    if (this.edges.has(edgeKey)) return;
    const targetKey = key(edge.target.projectId, edge.target.runId);
    this.edges.set(edgeKey, { waiterProjectId, waiterRunId, edgeId: edge.id, targetKey, deadline: Date.parse(edge.deadline) });
    if (!this.byTarget.has(targetKey)) this.byTarget.set(targetKey, new Set());
    this.byTarget.get(targetKey)!.add(edgeKey);
    if (!this.byWaiter.has(waiterKey)) this.byWaiter.set(waiterKey, new Set());
    this.byWaiter.get(waiterKey)!.add(edgeKey);
    this.arm(edgeKey);
  }

  private unindex(edgeKey: string): IndexedEdge | undefined {
    const indexed = this.edges.get(edgeKey);
    if (!indexed) return undefined;
    this.edges.delete(edgeKey);
    this.byTarget.get(indexed.targetKey)?.delete(edgeKey);
    if (this.byTarget.get(indexed.targetKey)?.size === 0) this.byTarget.delete(indexed.targetKey);
    const waiterKey = key(indexed.waiterProjectId, indexed.waiterRunId);
    this.byWaiter.get(waiterKey)?.delete(edgeKey);
    if (this.byWaiter.get(waiterKey)?.size === 0) this.byWaiter.delete(waiterKey);
    const timer = this.timers.get(edgeKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(edgeKey);
    return indexed;
  }

  private arm(edgeKey: string): void {
    const indexed = this.edges.get(edgeKey);
    if (!indexed || this.disposed) return;
    const previous = this.timers.get(edgeKey);
    if (previous) clearTimeout(previous);
    const delay = Math.max(0, Math.min(indexed.deadline - this.now(), MAX_TIMER_MS));
    const timer = setTimeout(() => {
      this.timers.delete(edgeKey);
      if (!this.edges.has(edgeKey)) return;
      if (this.now() < indexed.deadline) this.arm(edgeKey);
      else this.evaluate(edgeKey);
    }, delay);
    timer.unref?.();
    this.timers.set(edgeKey, timer);
  }

  /** Decide one indexed edge from the state of the world: deadline, target project, target run. */
  private evaluate(edgeKey: string): void {
    const indexed = this.edges.get(edgeKey);
    if (!indexed) return;
    const [targetProjectId, targetRunId] = indexed.targetKey.split('\u0000') as [string, string];
    const targetCtx = this.deps.peek(targetProjectId);
    const target = targetCtx?.store.getRun(targetRunId);
    if (targetCtx && !target) {
      this.resolve(edgeKey, 'target-deleted');
      return;
    }
    if (target && isTerminalStatus(target.status)) {
      this.resolve(edgeKey, 'settled');
      return;
    }
    if (this.now() >= indexed.deadline) {
      this.resolve(edgeKey, 'timed-out');
      return;
    }
    // The target's project is not built: build it, so its runs actually progress — its own
    // catch-up re-evaluates this edge. A project that cannot be built is unavailable.
    if (!targetCtx) void this.ensureBuilt(targetProjectId);
  }

  private async ensureBuilt(projectId: string): Promise<void> {
    if (this.deps.peek(projectId)) {
      this.contextBuilt(projectId);
      return;
    }
    try {
      await this.deps.build(projectId);
      if (!this.attached.has(projectId)) this.contextBuilt(projectId);
    } catch {
      if (this.disposed) return;
      for (const [edgeKey, indexed] of [...this.edges]) {
        if (indexed.targetKey.startsWith(`${projectId}\u0000`)) this.resolve(edgeKey, 'target-unavailable');
      }
    }
  }

  private onSettled(projectId: string, runId: string): void {
    const runKey = key(projectId, runId);
    for (const edgeKey of [...(this.byTarget.get(runKey) ?? [])]) this.resolve(edgeKey, 'settled');
    for (const edgeKey of [...(this.byWaiter.get(runKey) ?? [])]) this.resolve(edgeKey, 'waiter-ended');
  }

  private onDeleted(projectId: string, runId: string): void {
    const runKey = key(projectId, runId);
    for (const edgeKey of [...(this.byTarget.get(runKey) ?? [])]) this.resolve(edgeKey, 'target-deleted');
    // The waiter's record is gone with its edges — nothing to write, only the index to drop.
    for (const edgeKey of [...(this.byWaiter.get(runKey) ?? [])]) this.unindex(edgeKey);
  }

  /** Resolve one indexed edge: drop it from the index, persist the resolution on the waiter, and
   *  deliver the message (unless the waiter itself has ended). */
  private resolve(edgeKey: string, state: Exclude<WaitState, 'pending'>): void {
    const indexed = this.unindex(edgeKey);
    if (!indexed) return;
    const ctx = this.deps.peek(indexed.waiterProjectId);
    if (!ctx) return;
    this.writeResolution(ctx, indexed.waiterRunId, indexed.edgeId, state);
  }

  /**
   * Persist one edge's resolution and deliver its message. A waiter that has itself settled gets
   * `waiter-ended` whatever fired — there is nobody left to tell. Resolved history is trimmed to
   * the newest `WAIT_MAX_HISTORY`; pending edges are never trimmed.
   */
  private writeResolution(ctx: WaitProjectContext, waiterRunId: string, edgeId: string, requested: Exclude<WaitState, 'pending'>): void {
    const waiter = ctx.store.getRun(waiterRunId);
    const edge = waiter?.waits?.find((candidate) => candidate.id === edgeId);
    if (!waiter || !edge || edge.state !== 'pending') return;
    const state: Exclude<WaitState, 'pending'> = isTerminalStatus(waiter.status) ? 'waiter-ended' : requested;
    const targetCtx = this.deps.peek(edge.target.projectId);
    const target = targetCtx?.store.getRun(edge.target.runId);
    const resolved: WaitEdge = {
      ...edge,
      state,
      resolvedAt: new Date(this.now()).toISOString(),
      ...(target && state !== 'waiter-ended'
        ? {
            outcome: {
              status: target.status,
              ...(target.pullRequestUrl ? { prUrl: target.pullRequestUrl } : {}),
              ...(target.costUsd !== undefined ? { costUsd: target.costUsd } : {}),
            },
          }
        : {}),
    };
    const all = (waiter.waits ?? []).map((candidate) => (candidate.id === edgeId ? resolved : candidate));
    const stillPending = all.filter((candidate) => candidate.state === 'pending');
    const history = all.filter((candidate) => candidate.state !== 'pending').slice(-WAIT_MAX_HISTORY);
    const keep = new Set([...stillPending, ...history].map((candidate) => candidate.id));
    ctx.store.updateRun(waiterRunId, { waits: all.filter((candidate) => keep.has(candidate.id)) });

    const name = `"${edge.targetTitle}" (${waitRef(edge.target.projectId, edge.target.runId)})`;
    ctx.store.appendEvent(waiterRunId, {
      type: 'note',
      message: state === 'settled' && target
        ? `wait ended: ${name} settled — ${target.status}${target.costUsd !== undefined ? `, ${usd(target.costUsd)}` : ''}`
        : `wait ended: ${name} — ${state}`,
    });
    if (state === 'waiter-ended') return;

    const minutes = Math.round((Date.parse(edge.deadline) - Date.parse(edge.createdAt)) / 60_000);
    const text = state === 'settled' && target
      ? settledMessage(edge.target.projectId, target, stillPending.length)
      : resolutionMessage(edge, state, stillPending.length, { ...(target ? { status: target.status } : {}), minutes });
    if (!text) return;
    let delivered = false;
    try {
      delivered = ctx.manager.deliverWaitNotice(waiterRunId, text);
    } catch {
      delivered = false;
    }
    if (!delivered) {
      ctx.store.appendEvent(waiterRunId, {
        type: 'note',
        message: 'the wait outcome could not be delivered into a live session — it stays on the record (cez task waits)',
      });
    }
  }
}
