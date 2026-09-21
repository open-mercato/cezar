import type { AutomationCoordinator } from './coordinator.ts';
import type { GithubCandidate, GithubPoller, GithubPollResult } from './github-poller.ts';
import { ScheduleRunner, type ScheduleLauncher } from './schedule-runner.ts';
import type { AutomationLease, AutomationStore } from './store.ts';
import { isGithubAutomation, isScheduleAutomation, type GithubAutomationDefinition } from './types.ts';

const CURSOR_OVERLAP_MS = 120_000;

/** Another process is polling this project right now. A skip, not a broken automation. */
export class LeaseHeldError extends Error {
  constructor() { super('automation polling lease is held by another process'); }
}

export interface AutomationLaunchResult { runId: string }
export type AutomationLauncher = (
  definition: GithubAutomationDefinition,
  candidate: GithubCandidate,
  receiptId: string,
) => Promise<AutomationLaunchResult>;

/**
 * One project as the schedulers see it. `github` is present only for a project whose remote is
 * on github.com (spec 2026-09-14-automations-redesign): a project without it still gets a
 * handle, so its scheduled automations fire — only the poll kind is skipped.
 */
export interface ProjectAutomationHandle {
  projectId: string;
  store: AutomationStore;
  /** The zone every schedule is evaluated in — the server's own. */
  timeZone: string;
  github?: { owner: string; repo: string; poller: GithubPoller };
  launch?: AutomationLauncher;
  launchSchedule?: ScheduleLauncher;
  onChange?: (automationId: string, revision: number) => void;
  now?: () => number;
}

/** One request chain process-wide. The promise tail also prevents a failed request from
 * poisoning later projects. */
class GithubRequestArbiter {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.tail.then(operation, operation);
    this.tail = current.catch(() => undefined);
    return current;
  }
}
const githubRequests = new GithubRequestArbiter();

export class ProjectAutomationScheduler {
  constructor(private readonly handle: ProjectAutomationHandle) {}

  async check(definition: GithubAutomationDefinition, mode: 'preview' | 'execute' = 'execute'): Promise<GithubPollResult> {
    const github = this.handle.github;
    if (!github) throw new Error('No GitHub remote is configured');
    const detectionOnly = mode === 'execute' && !this.handle.launch;
    if (detectionOnly) mode = 'preview';
    /** This call is the scheduler's own turn, not a by-hand preview from the API. */
    const scheduled = mode === 'execute' || detectionOnly;
    const { store } = this.handle;
    const started = Date.now();
    let completion: { result: 'preview' | 'no-match'; reason: string } | undefined;
    let lease: AutomationLease | undefined;
    try {
      // Inside the try: a lease we cannot take is the one failure mode that used to produce no
      // diagnostics at all, and it is the one that lasted longest (#983).
      lease = store.acquireLease();
      if (!lease) throw new LeaseHeldError();
      const state = store.state(definition.id) ?? {};
      if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) {
        throw new Error(`automation is backed off until ${state.backoffUntil}`);
      }
      const since = state.cursor?.timestamp ?? state.baselineAt;
      const overlapSince = since
        ? new Date(Date.parse(since) - CURSOR_OVERLAP_MS).toISOString()
        : undefined;
      const result = await githubRequests.run(() => github.poller.poll(
        github.owner,
        github.repo,
        definition,
        { since: overlapSince },
      ));
      const eligible = result.candidates.filter((candidate) => {
        if (state.baselineAt && candidate.timestamp <= state.baselineAt) return false;
        if (!state.cursor) return true;
        const overlap = Date.parse(state.cursor.timestamp) - 120_000;
        return Date.parse(candidate.timestamp) >= overlap;
      });
      if (mode === 'execute' && this.handle.launch) {
        for (const candidate of eligible) await this.launch(definition, candidate);
      }
      if (mode === 'execute') {
        const now = new Date().toISOString();
        store.setState(definition.id, (current) => {
          const cursor = laterCursor(current.cursor, result.cursor);
          return {
            ...current,
            revision: definition.revision,
            cursor,
            frozenHighWatermark: result.truncated && cursor?.tieBreaker
              ? { timestamp: cursor.timestamp, tieBreaker: cursor.tieBreaker }
              : undefined,
            lastSuccessAt: now,
            nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
            consecutiveFailures: 0,
            backoffUntil: undefined,
          };
        });
      } else if (detectionOnly) {
        store.setState(definition.id, (current) => ({
          ...current,
          revision: definition.revision,
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
        }));
      }
      this.handle.onChange?.(definition.id, definition.revision);
      completion = mode === 'preview'
        ? { result: 'preview', reason: `Bounded preview found ${eligible.length} match${eligible.length === 1 ? '' : 'es'}; no tasks were launched.` }
        : { result: 'no-match', reason: 'Scheduled check completed.' };
      return { ...result, candidates: eligible };
    } catch (error) {
      if (error instanceof LeaseHeldError) this.recordSkip(definition, error, scheduled);
      else if (mode === 'execute') this.recordFailure(definition, error);
      else store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (completion) store.appendLog({ automationId: definition.id, revision: definition.revision, ...completion, durationMs: Date.now() - started });
      if (lease) {
        // Compaction rewrites the NDJSON files: only ever under the lease we actually hold.
        try { store.maybeCompact(); } catch { /* append-only state remains readable; next check retries */ }
        lease.release();
      }
    }
  }

  private async launch(definition: GithubAutomationDefinition, candidate: GithubCandidate): Promise<void> {
    if (this.hasRecentReviewRequestReceipt(definition, candidate)) {
      this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'duplicate', reason: 'A durable receipt already exists for this automation and pull request review-request burst.', githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
      return;
    }
    const receipt = this.handle.store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: candidate.eventId, candidate });
    if (!receipt) {
      this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'duplicate', reason: 'A durable receipt already exists for this automation and event.', githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
      return;
    }
    try {
      const launched = await this.handle.launch!(definition, candidate, receipt.receiptId);
      this.handle.store.appendReceipt({ ...receipt, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
      this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'launched', receiptId: receipt.receiptId, runId: launched.runId, githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
    } catch (error) {
      this.handle.store.appendReceipt({ ...receipt, status: 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
      throw error;
    }
  }

  private hasRecentReviewRequestReceipt(definition: GithubAutomationDefinition, candidate: GithubCandidate): boolean {
    if (!isReviewRequestEvent(candidate.event)) return false;
    const candidateAt = Date.parse(candidate.timestamp);
    if (!Number.isFinite(candidateAt)) return false;
    // The poller collapses all visible reviewer rows per PR. If GitHub indexes the next row just
    // after a poll, the following poll sees a new raw event id; keep the per-PR burst contract here.
    const burstWindowMs = Math.max(definition.intervalSeconds * 1_000, CURSOR_OVERLAP_MS);
    for (const receipt of this.handle.store.latestReceipts().values()) {
      const previous = receipt.candidate;
      if (receipt.automationId !== definition.id || !previous || !isReviewRequestEvent(previous.event)) continue;
      if (previous.repo !== candidate.repo || previous.nodeId !== candidate.nodeId) continue;
      const previousAt = Date.parse(previous.timestamp);
      if (Number.isFinite(previousAt) && Math.abs(candidateAt - previousAt) <= burstWindowMs) return true;
    }
    return false;
  }

  /**
   * A lease held elsewhere is a skip, not a failure: another cockpit is polling this project and
   * will do the work. Log it so the poll that did not happen leaves a trace, and move our own
   * `nextCheckAt` on by one interval — without touching `consecutiveFailures`/`backoffUntil`,
   * which are for the automation being broken. `ScheduleRunner.launch` treats the same condition
   * the same way.
   */
  private recordSkip(definition: GithubAutomationDefinition, error: Error, scheduled: boolean): void {
    const { store } = this.handle;
    store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'skipped', reason: error.message });
    if (!scheduled) return;
    store.setState(definition.id, (current) => ({
      ...current,
      nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
    }));
    this.handle.onChange?.(definition.id, definition.revision);
  }

  private recordFailure(definition: GithubAutomationDefinition, error: unknown): void {
    this.handle.store.setState(definition.id, (current) => {
      const failures = (current.consecutiveFailures ?? 0) + 1;
      const delay = Math.min(6 * 60 * 60_000, 60_000 * 2 ** (failures - 1));
      return {
        ...current,
        consecutiveFailures: failures,
        backoffUntil: new Date(Date.now() + delay).toISOString(),
        nextCheckAt: new Date(Date.now() + delay).toISOString(),
      };
    });
    this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
    this.handle.onChange?.(definition.id, definition.revision);
  }
}

function isReviewRequestEvent(event: GithubCandidate['event']): boolean {
  return event === 'pull_request.review_requested' || event === 'pull_request.rereview_requested';
}

function laterCursor(
  current: { timestamp: string; tieBreaker?: string } | undefined,
  observed: { timestamp: string; tieBreaker: string } | undefined,
): { timestamp: string; tieBreaker?: string } | undefined {
  if (!observed) return current;
  if (!current) return observed;
  const order = observed.timestamp.localeCompare(current.timestamp)
    || observed.tieBreaker.localeCompare(current.tieBreaker ?? '');
  return order > 0 ? observed : current;
}

/** The shortest a failed item is ever pushed out; a poll interval is at least this anyway. */
const MIN_RETRY_MS = 60_000;

export interface WorkspaceAutomationSchedulerOptions {
  coordinator: AutomationCoordinator;
  handle: (projectId: string, store: AutomationStore) => ProjectAutomationHandle | undefined;
  now?: () => number;
}

/** One workspace timer, created only while at least one enabled definition exists. */
export class WorkspaceAutomationScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private scheduleGeneration = 0;
  /** `projectId:automationId` → the instant a just-failed item may be tried again. */
  private readonly retryAfter = new Map<string, number>();
  constructor(private readonly options: WorkspaceAutomationSchedulerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.reschedule();
  }

  async reschedule(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.scheduleGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.options.coordinator.refresh();
    if (this.stopped || generation !== this.scheduleGeneration) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.scheduleGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  hasTimer(): boolean { return this.timer !== undefined; }

  /**
   * Arm ONE timer for the earliest due item across every project and both kinds: a poll is due
   * at its `nextCheckAt`, a schedule at its `nextRunAt` (computed and persisted on first sight by
   * `ScheduleRunner.dueAt`). A poll whose project has no GitHub remote is skipped — the handle
   * says so — and a schedule needs no remote at all.
   */
  private schedule(): void {
    if (this.stopped) return;
    const now = this.options.now?.() ?? Date.now();
    const due: Array<{ key: string; at: number; retryAfterMs: number; fire: () => Promise<unknown> }> = [];
    const live = new Set<string>();
    for (const projectId of this.options.coordinator.enabledProjectIds()) {
      const store = this.options.coordinator.store(projectId);
      if (!store) continue;
      const handle = this.options.handle(projectId, store);
      if (!handle) continue;
      for (const definition of store.list().filter((item) => item.enabled)) {
        const key = `${projectId}:${definition.id}`;
        live.add(key);
        if (isGithubAutomation(definition)) {
          if (!handle.github) continue;
          const scheduler = new ProjectAutomationScheduler(handle);
          const at = Date.parse(store.state(definition.id)?.nextCheckAt ?? new Date(now).toISOString());
          due.push({ key, at: this.notBefore(key, at), retryAfterMs: Math.max(definition.intervalSeconds * 1_000, MIN_RETRY_MS), fire: () => scheduler.check(definition) });
        } else if (isScheduleAutomation(definition)) {
          const runner = new ScheduleRunner({ ...handle, launch: handle.launchSchedule, now: this.options.now });
          const at = runner.dueAt(definition);
          if (at === null) continue;
          due.push({ key, at: this.notBefore(key, at), retryAfterMs: MIN_RETRY_MS, fire: () => runner.fire(definition) });
        }
      }
    }
    for (const key of this.retryAfter.keys()) if (!live.has(key)) this.retryAfter.delete(key);
    if (!due.length) return;
    due.sort((a, b) => a.at - b.at);
    const next = due[0]!;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void next.fire().then(
        () => { this.retryAfter.delete(next.key); },
        // Never re-arm a rejected item at its own past `at` (#983): that is a zero-delay spin, and
        // because one timer serves the whole workspace it also starves every other project until
        // something else moves the item forward. The floor is this workspace's own memory of the
        // failure — independent of whatever the project's store did or did not manage to persist.
        () => { this.retryAfter.set(next.key, (this.options.now?.() ?? Date.now()) + next.retryAfterMs); },
      ).finally(() => this.schedule());
    }, Math.max(0, next.at - now));
  }

  /** An item that just failed waits out its retry floor, however due its persisted state looks. */
  private notBefore(key: string, at: number): number {
    return Math.max(at, this.retryAfter.get(key) ?? 0);
  }
}
