import type { AutomationCoordinator } from './coordinator.js';
import type { GithubCandidate, GithubPoller, GithubPollResult } from './github-poller.js';
import type { AutomationStore } from './store.js';
import type { AutomationDefinition } from './types.js';

export interface AutomationLaunchResult { runId: string }
export type AutomationLauncher = (
  definition: AutomationDefinition,
  candidate: GithubCandidate,
  receiptId: string,
) => Promise<AutomationLaunchResult>;

export interface ProjectAutomationHandle {
  projectId: string;
  owner: string;
  repo: string;
  store: AutomationStore;
  poller: GithubPoller;
  launch?: AutomationLauncher;
  onChange?: (automationId: string, revision: number) => void;
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

  async check(definition: AutomationDefinition, mode: 'preview' | 'execute' = 'execute'): Promise<GithubPollResult> {
    const detectionOnly = mode === 'execute' && !this.handle.launch;
    if (detectionOnly) mode = 'preview';
    const { store } = this.handle;
    const lease = store.acquireLease();
    if (!lease) throw new Error('automation polling lease is held by another process');
    const started = Date.now();
    let completion: { result: 'preview' | 'no-match'; reason: string } | undefined;
    try {
      const state = store.state(definition.id) ?? {};
      if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) {
        throw new Error(`automation is backed off until ${state.backoffUntil}`);
      }
      const since = state.cursor?.timestamp ?? state.baselineAt;
      const overlapSince = since
        ? new Date(Date.parse(since) - 120_000).toISOString()
        : undefined;
      const result = await githubRequests.run(() => this.handle.poller.poll(
        this.handle.owner,
        this.handle.repo,
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
        const cursor = laterCursor(state.cursor, result.cursor);
        store.setState(definition.id, {
          ...state,
          revision: definition.revision,
          cursor,
          frozenHighWatermark: result.truncated && cursor?.tieBreaker
            ? { timestamp: cursor.timestamp, tieBreaker: cursor.tieBreaker }
            : undefined,
          lastSuccessAt: now,
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
          consecutiveFailures: 0,
          backoffUntil: undefined,
        });
      } else if (detectionOnly) {
        store.setState(definition.id, {
          ...state,
          revision: definition.revision,
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
        });
      }
      this.handle.onChange?.(definition.id, definition.revision);
      completion = mode === 'preview'
        ? { result: 'preview', reason: `Bounded preview found ${eligible.length} match${eligible.length === 1 ? '' : 'es'}; no tasks were launched.` }
        : { result: 'no-match', reason: 'Scheduled check completed.' };
      return { ...result, candidates: eligible };
    } catch (error) {
      if (mode === 'execute') this.recordFailure(definition, error);
      else store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (completion) store.appendLog({ automationId: definition.id, revision: definition.revision, ...completion, durationMs: Date.now() - started });
      try { store.maybeCompact(); } catch { /* append-only state remains readable; next check retries */ }
      lease.release();
    }
  }

  private async launch(definition: AutomationDefinition, candidate: GithubCandidate): Promise<void> {
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

  private recordFailure(definition: AutomationDefinition, error: unknown): void {
    const state = this.handle.store.state(definition.id) ?? {};
    const failures = (state.consecutiveFailures ?? 0) + 1;
    const delay = Math.min(6 * 60 * 60_000, 60_000 * 2 ** (failures - 1));
    this.handle.store.setState(definition.id, {
      ...state,
      consecutiveFailures: failures,
      backoffUntil: new Date(Date.now() + delay).toISOString(),
      nextCheckAt: new Date(Date.now() + delay).toISOString(),
    });
    this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
    this.handle.onChange?.(definition.id, definition.revision);
  }
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

  private schedule(): void {
    if (this.stopped) return;
    const due: Array<{ at: number; definition: AutomationDefinition; scheduler: ProjectAutomationScheduler }> = [];
    for (const projectId of this.options.coordinator.enabledProjectIds()) {
      const store = this.options.coordinator.store(projectId);
      if (!store) continue;
      const handle = this.options.handle(projectId, store);
      if (!handle) continue;
      for (const definition of store.list().filter((item) => item.enabled)) {
        due.push({ at: Date.parse(store.state(definition.id)?.nextCheckAt ?? new Date().toISOString()), definition, scheduler: new ProjectAutomationScheduler(handle) });
      }
    }
    if (!due.length) return;
    due.sort((a, b) => a.at - b.at);
    const next = due[0]!;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void next.scheduler.check(next.definition).catch(() => undefined).finally(() => this.schedule());
    }, Math.max(0, next.at - (this.options.now?.() ?? Date.now())));
  }
}
