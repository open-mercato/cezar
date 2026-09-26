import { runEventPollCycle, launchEventCandidate } from './event-poll-cycle.ts';
import type { AutomationCoordinator } from './coordinator.ts';
import type { GithubCandidate, GithubPoller, GithubPollResult } from './github-poller.ts';
import { ScheduleRunner, type ScheduleLauncher } from './schedule-runner.ts';
import type { AutomationStore } from './store.ts';
import type { TrackerDriver } from '../server/tracker/types.ts';
import type { TrackerFailure } from '@open-mercato/cezar-contract';
import { TrackerPoller, type TrackerAutomationCandidate } from './tracker-poller.ts';
import { isGithubAutomation, isScheduleAutomation, isTrackerAutomation, type GithubAutomationDefinition, type TrackerAutomationDefinition } from './types.ts';

const CURSOR_OVERLAP_MS = 120_000;

export { LeaseHeldError } from './event-poll-cycle.ts';

export interface AutomationLaunchResult { runId: string }
export type AutomationLauncher = (
  definition: GithubAutomationDefinition,
  candidate: GithubCandidate,
  receiptId: string,
) => Promise<AutomationLaunchResult>;
export type TrackerAutomationLauncher = (
  definition: TrackerAutomationDefinition,
  candidate: TrackerAutomationCandidate,
  receiptId: string,
) => Promise<AutomationLaunchResult>;

/**
 * One project as the schedulers see it. `github` is present only for a project whose remote is
 * on github.com (spec 2026-09-14-automations-redesign): a project without it still gets a
 * handle, so its scheduled automations fire — only the poll kind is skipped. `tracker` mirrors
 * this for a project with no Jira/Linear connection configured (2026-09-19 discussion).
 */
export interface ProjectAutomationHandle {
  projectId: string;
  store: AutomationStore;
  /** The zone every schedule is evaluated in — the server's own. */
  timeZone: string;
  github?: { owner: string; repo: string; poller: GithubPoller };
  /** `getDriver` re-resolves the project's tracker connection on every poll (it can be added,
   *  removed or reconnected between ticks) rather than being captured once at handle build time. */
  tracker?: { getDriver: () => Promise<TrackerDriver | TrackerFailure>; poller: TrackerPoller };
  launch?: AutomationLauncher;
  launchSchedule?: ScheduleLauncher;
  launchTracker?: TrackerAutomationLauncher;
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
    return runEventPollCycle({
      store, definition, mode, scheduled, onChange: this.handle.onChange,
      poll: state => {
        const since = state.cursor?.timestamp ?? state.baselineAt;
        return githubRequests.run(() => github.poller.poll(github.owner, github.repo, definition,
          { since: since ? new Date(Date.parse(since) - CURSOR_OVERLAP_MS).toISOString() : undefined }));
      },
      eligible: (candidate, state) => !state.cursor || Date.parse(candidate.timestamp) >= Date.parse(state.cursor.timestamp) - CURSOR_OVERLAP_MS,
      launch: (candidate: GithubCandidate) => this.launch(definition, candidate),
      persist: (result, current) => {
        const cursor = laterCursor(current.cursor, result.cursor);
        return {
          ...current, revision: definition.revision, cursor,
          frozenHighWatermark: result.truncated && cursor?.tieBreaker ? { timestamp: cursor.timestamp, tieBreaker: cursor.tieBreaker } : undefined,
          lastSuccessAt: new Date().toISOString(),
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1000).toISOString(),
          consecutiveFailures: 0,
          backoffUntil: undefined,
        };
      },
    }).then(result => {
      if (detectionOnly && store.get(definition.id)?.revision === definition.revision) {
        store.setState(definition.id, current => ({
          ...current,
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1000).toISOString(),
        }));
      }
      return result;
    });
  }

  private async launch(definition: GithubAutomationDefinition, candidate: GithubCandidate): Promise<void> {
    if (this.hasRecentReviewRequestReceipt(definition, candidate)) {
      this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'duplicate', reason: 'A durable receipt already exists for this automation and pull request review-request burst.', githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
      return;
    }
    await launchEventCandidate({ store: this.handle.store, definition,
      receipt: { eventId: candidate.eventId, candidate },
      log: { event: candidate.event, githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url },
      launch: receiptId => this.handle.launch!(definition, candidate, receiptId),
    });
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
}

/** Tracker facade for the shared event cycle; provider adapters own history and checkpoints. */
export class ProjectTrackerAutomationScheduler {
  constructor(private readonly handle: ProjectAutomationHandle) {}

  async check(definition: TrackerAutomationDefinition, mode: 'preview' | 'execute' = 'execute') {
    const tracker = this.handle.tracker;
    if (!tracker || !definition.trackerTrigger) {
      throw new Error('Choose an event to finish configuring this automation');
    }
    const association = definition.trackerTrigger.association;
    const isCurrent = async () => {
      const driver = await tracker.getDriver();
      return !('available' in driver) && JSON.stringify(driver.association) === JSON.stringify(association);
    };
    return runEventPollCycle({
      store: this.handle.store, definition,
      mode: this.handle.launchTracker ? mode : 'preview',
      scheduled: mode === 'execute',
      onChange: this.handle.onChange, isCurrent,
      prepareState: state => {
        if (state.baselineAt) return;
        // Missing runtime state cannot safely replay historical events. Persist the
        // replacement before polling so every checkpoint shares this same baseline.
        const baselineAt = new Date().toISOString();
        this.handle.store.setState(definition.id, current => ({
          ...current, revision: definition.revision, baselineAt,
          checkpoint: undefined, consecutiveFailures: 0, backoffUntil: undefined,
        }));
        this.handle.store.appendLog({
          automationId: definition.id, revision: definition.revision, result: 'baseline',
          reason: `Tracker runtime baseline was missing; continuity gap before ${baselineAt}. Historical backlog was skipped.`,
        });
      },
      poll: async state => {
        const driver = await tracker.getDriver();
        if ('available' in driver) throw new Error(driver.reason);
        if (JSON.stringify(driver.association) !== JSON.stringify(association)) {
          throw new Error('Tracker connection or scope changed; save this automation again');
        }
        const fallbackBaseline = Date.now()
          - (mode === 'preview' ? definition.filters.lookbackDays * 86_400_000 : 0);
        const result = await tracker.poller.poll(driver, definition, {
          baselineAt: state.baselineAt ?? new Date(fallbackBaseline).toISOString(),
          checkpoint: state.checkpoint,
        });
        for (const gap of result.gaps ?? []) {
          this.handle.store.appendLog({
            automationId: definition.id, revision: definition.revision,
            result: 'skipped', trackerKey: gap.key,
            reason: `Tracker history continuity gap: ${gap.reason}`,
          });
        }
        return result;
      },
      launch: (candidate: TrackerAutomationCandidate) => this.launch(definition, candidate),
      persist: (result, current) => ({
        ...current, revision: definition.revision, checkpoint: result.checkpoint,
        lastSuccessAt: new Date().toISOString(),
        nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1000).toISOString(),
        consecutiveFailures: 0,
        backoffUntil: undefined,
      }),
    });
  }

  private async launch(definition: TrackerAutomationDefinition, candidate: TrackerAutomationCandidate): Promise<void> {
    await launchEventCandidate({ store: this.handle.store, definition,
      receipt: { eventId: candidate.eventId, trackerCandidate: candidate },
      log: { event: candidate.event, trackerKey: candidate.key, trackerTitle: candidate.title, trackerUrl: candidate.url },
      launch: receiptId => this.handle.launchTracker!(definition, candidate, receiptId),
    });
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
        } else if (isTrackerAutomation(definition)) {
          if (!handle.tracker) continue;
          const scheduler = new ProjectTrackerAutomationScheduler(handle);
          const at = Date.parse(store.state(definition.id)?.nextCheckAt ?? new Date(now).toISOString());
          due.push({ key, at: this.notBefore(key, at), retryAfterMs: Math.max(definition.intervalSeconds * 1000, MIN_RETRY_MS), fire: () => scheduler.check(definition) });
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
