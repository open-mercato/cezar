import { readDashboardAutomations } from './dashboard-automations.ts';
import { buildDashboardOverview } from './dashboard-overview.ts';
import type { DashboardOverviewQuery } from '@open-mercato/cezar-contract';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  dashboardTaskRowSchema,
  type DashboardCoverage,
  type DashboardCostTask,
  type DashboardCostsQuery,
  type DashboardCounts,
  type DashboardFeed,
  type DashboardFeedSource,
  type DashboardFeedRow,
  type DashboardGroup,
  type DashboardPage,
  type DashboardSnapshot,
  type DashboardTaskRow,
  type DashboardTasksPage,
  type DashboardTelemetry,
} from '@open-mercato/cezar-contract';
import {
  DashboardCostSnapshots,
  projectCostTask,
  type CostVisibility,
} from './dashboard-costs.ts';
import { currentTimedUsage } from '../core/process-usage.ts';
import { readRunIndexDiagnostic } from '../runs/run-index.ts';
import type { RunStore } from '../runs/store.ts';
import { getDashboardGithub } from './dashboard-forge.ts';

type Project = { id: string; root: string; store?: RunStore };
type Projection = {
  generation: number;
  rows: DashboardTaskRow[];
  costRows: DashboardCostTask[];
  coverage: DashboardCoverage;
  projects: Project[];
};
type Saved = Projection & { snapshot: DashboardSnapshot; revision: string };
type Cached = {
  identity: string;
  rows: DashboardTaskRow[];
  costRows: DashboardCostTask[];
  coverage: DashboardCoverage['projects'][number];
  builtAt: number;
};
const TTL = 60_000;
const WINDOW = 7 * 24 * 60 * 60_000;
const order = (a: DashboardTaskRow, b: DashboardTaskRow) =>
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id) ||
  a.projectId.localeCompare(b.projectId);
function group(rows: DashboardTaskRow[], name: DashboardGroup): DashboardTaskRow[] {
  const selected = rows
    .filter((r) => {
      if (r.archived) return false;
      if (name === 'running') return r.status === 'running';
      if (name === 'queued') return r.status === 'queued';
      if (name === 'scheduled') return r.status === 'failed' && Boolean(r.autoResumeAt);
      if (name === 'questions') return r.status === 'waiting';
      if (name === 'reviews') return r.status === 'review';
      return r.status === 'waiting' || r.status === 'review';
    })
    .sort(order);
  return name === 'needs-you'
    ? selected
        .filter((r) => r.status === 'waiting')
        .concat(selected.filter((r) => r.status === 'review'))
    : selected;
}
function page(rows: DashboardTaskRow[], offset: number, limit: number): DashboardPage {
  return {
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
  };
}

/** Demand-driven read-only projection. No contexts, watchers, sampling or background refresh. */
export class DashboardReader {
  private readonly cache = new Map<string, Cached>();
  private readonly stores = new Map<
    string,
    { root: string; store: RunStore; version: number; detach: () => void }
  >();
  private readonly saved: Saved[] = [];
  private readonly costSnapshots: DashboardCostSnapshots;
  private pending: Promise<Projection> | undefined;
  private generation = 0;
  private disposed = false;
  private readonly wakeRefresh = new Set<() => void>();
  private readonly now: () => number;
  constructor(
    private readonly deps: {
      projects: () => Promise<Project[]>;
      now?: () => number;
      github?: typeof getDashboardGithub;
      telemetryProjects?: () => Promise<Project[]>;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.costSnapshots = new DashboardCostSnapshots(this.now);
  }

  async automations(projectId: string) {
    const project = (await this.deps.projects()).find((project) => project.id === projectId);
    return project ? readDashboardAutomations(project.root) : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const wake of this.wakeRefresh) wake();
    for (const owned of this.stores.values()) owned.detach();
    this.stores.clear();
    this.cache.clear();
    this.saved.length = 0;
    this.costSnapshots.clear();
  }

  invalidateProject(id: string): void {
    this.costSnapshots.invalidateProject(id);
    this.generation++;
    for (const wake of this.wakeRefresh) wake();
    this.cache.delete(id);
    this.stores.get(id)?.detach();
    this.stores.delete(id);
    for (let i = this.saved.length - 1; i >= 0; i--) {
      if (this.saved[i]!.projects.some((p) => p.id === id)) this.saved.splice(i, 1);
    }
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('Dashboard reader disposed');
  }

  private waitForRefresh(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakeRefresh.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, delay);
      this.wakeRefresh.add(wake);
    });
  }

  private async projects(): Promise<Project[]> {
    this.ensureActive();
    const generation = this.generation;
    const projects = await this.deps.projects();
    this.ensureActive();
    if (generation !== this.generation) return this.projects();
    this.costSnapshots.reconcile(projects);
    const ids = new Set(projects.map((p) => p.id));
    const roots = new Map(projects.map((p) => [p.id, p.root]));
    for (let i = this.saved.length - 1; i >= 0; i--) {
      if (
        this.saved[i]!.projects.some((p) => roots.get(p.id) !== p.root) ||
        Date.parse(this.saved[i]!.snapshot.expiresAt) <= this.now()
      )
        this.saved.splice(i, 1);
    }
    for (const [id, owned] of this.stores) {
      const current = projects.find((p) => p.id === id);
      if (!current || current.root !== owned.root || current.store !== owned.store)
        this.invalidateProject(id);
    }
    for (const id of this.cache.keys()) if (!ids.has(id)) this.invalidateProject(id);
    return projects;
  }

  private projection(): Promise<Projection> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let projection: Projection | undefined;
      let generation: number;
      do {
        this.ensureActive();
        generation = this.generation;
        projection = await this.readProjection(generation);
      } while (!projection || generation !== this.generation);
      this.ensureActive();
      return projection;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async readProjection(generation: number): Promise<Projection | undefined> {
    const projects = await this.projects();
    this.ensureActive();
    if (generation !== this.generation) return undefined;
    const rows: DashboardTaskRow[] = [];
    const costRows: DashboardCostTask[] = [];
    const coverage: DashboardCoverage = { projects: [] };
    for (const project of projects) {
      let identity: string;
      if (project.store) {
        let owned = this.stores.get(project.id);
        if (owned?.store !== project.store) {
          owned?.detach();
          const store = project.store;
          owned = {
            root: project.root,
            store,
            version: 0,
            detach: () => {
              store.off('run', changed);
              store.off('deleted', changed);
            },
          };
          const state = owned;
          const changed = () => {
            state.version++;
          };
          store.on('run', changed);
          store.on('deleted', changed);
          this.stores.set(project.id, owned);
          this.cache.delete(project.id);
        }
        identity = `owned:${project.root}:${owned.version}`;
      } else {
        const owned = this.stores.get(project.id);
        if (owned) {
          owned.detach();
          this.stores.delete(project.id);
        }
        try {
          const root = statSync(project.root);
          const stat = statSync(join(project.root, '.ai/cezar/runs.json'));
          identity = `${project.root}:${root.ino}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        } catch {
          // Recheck errors on every demanded read: repaired permissions or an absent index
          // becoming readable must not pin an unavailable state indefinitely.
          identity = `unreadable:${randomUUID()}`;
        }
      }
      let cached = this.cache.get(project.id);
      if (cached && cached.identity !== identity && project.store) {
        const remaining = 1000 - (this.now() - cached.builtAt);
        // Throttle rebuilds, not freshness. A requested refresh waits for the bound;
        // serving the stale revision here would defer a 250ms SSE invalidation until
        // the 15-second reconciliation poll. Concurrent requests share this promise.
        if (remaining > 0) await this.waitForRefresh(remaining);
        this.ensureActive();
        if (generation !== this.generation) return undefined;
        identity = `owned:${project.root}:${this.stores.get(project.id)?.version ?? 0}`;
      }
      if (!cached || cached.identity !== identity) {
        const diagnostic = project.store
          ? { runs: project.store.listRuns(), ...project.store.getIndexReadHealth() }
          : readRunIndexDiagnostic(join(project.root, '.ai/cezar'), project.root);
        const slim: DashboardTaskRow[] = [];
        let omitted = diagnostic.omittedRuns;
        for (const run of diagnostic.runs) {
          const parsed = dashboardTaskRowSchema.safeParse({ ...run, projectId: project.id });
          if (parsed.success) slim.push(parsed.data);
          else omitted++;
        }
        cached = {
          identity,
          rows: slim,
          costRows: diagnostic.runs.map((run) => projectCostTask(project.id, run)),
          builtAt: this.now(),
          coverage: {
            projectId: project.id,
            state:
              diagnostic.state === 'unavailable'
                ? 'unavailable'
                : omitted || diagnostic.state === 'partial'
                  ? 'partial'
                  : 'complete',
            omittedRuns: omitted,
            ...('reason' in diagnostic
              ? { reason: diagnostic.reason }
              : omitted
                ? { reason: 'Some task records could not be read' }
                : {}),
          },
        };
        this.cache.set(project.id, cached);
      }
      rows.push(...cached.rows);
      costRows.push(...cached.costRows);
      coverage.projects.push(cached.coverage);
    }
    return { generation, rows, costRows, coverage, projects };
  }

  async costs(query: DashboardCostsQuery, policy: CostVisibility | (() => CostVisibility)) {
    let projection = await this.projection();
    while (projection.generation !== this.generation) projection = await this.projection();
    this.ensureActive();
    // Resolve runtime settings after any throttled read so an in-flight request cannot
    // reveal a measure disabled while project discovery was pending.
    const visibility = typeof policy === 'function' ? policy() : policy;
    this.costSnapshots.reconcileRows(projection.costRows, projection.coverage);
    if (query.snapshotId) return this.costSnapshots.read(query, visibility);
    return this.costSnapshots.capture(
      projection.costRows,
      projection.coverage,
      projection.projects,
      query,
      visibility,
    );
  }

  async snapshot(): Promise<DashboardSnapshot> {
    let projection = await this.projection();
    while (projection.generation !== this.generation) projection = await this.projection();
    this.ensureActive();
    const revision = JSON.stringify([projection.coverage, projection.rows]);
    const identical = this.saved.find((s) => s.revision === revision);
    if (identical) return identical.snapshot;
    const rows = projection.rows;
    const questions = group(rows, 'questions');
    const reviews = group(rows, 'reviews');
    let q = Math.min(3, questions.length);
    let r = Math.min(3, reviews.length);
    q += Math.min(6 - q - r, questions.length - q);
    r += Math.min(6 - q - r, reviews.length - r);
    const counts: DashboardCounts = {
      running: group(rows, 'running').length,
      monitoring: rows.filter(
        (r) => !r.archived && r.status === 'running' && r.activity === 'monitoring',
      ).length,
      questions: questions.length,
      reviews: reviews.length,
      queued: group(rows, 'queued').length,
      scheduled: group(rows, 'scheduled').length,
    };
    const now = this.now();
    const snapshot: DashboardSnapshot = {
      snapshotId: randomUUID(),
      asOf: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL).toISOString(),
      coverage: projection.coverage,
      counts,
      questions: page(questions, 0, q),
      reviews: page(reviews, 0, r),
    };
    this.saved.push({ ...projection, snapshot, revision });
    while (this.saved.length > 3) this.saved.shift();
    return snapshot;
  }

  async overview(query: DashboardOverviewQuery) {
    await this.projects();
    const snapshot = query.snapshotId
      ? this.saved.find((s) => s.snapshot.snapshotId === query.snapshotId)?.snapshot
      : await this.snapshot();
    if (!snapshot) return undefined;
    const saved = this.saved.find((s) => s.snapshot.snapshotId === snapshot.snapshotId);
    return saved ? buildDashboardOverview(saved.rows, snapshot, query) : undefined;
  }

  async tasks(
    snapshotId: string,
    name: DashboardGroup,
    offset: number,
    limit: number,
  ): Promise<DashboardTasksPage | undefined> {
    await this.projects();
    const saved = this.saved.find((s) => s.snapshot.snapshotId === snapshotId);
    if (!saved) return undefined;
    return {
      snapshotId,
      asOf: saved.snapshot.asOf,
      coverage: saved.coverage,
      page: page(group(saved.rows, name), offset, limit),
    };
  }

  /** Only owned stores and the existing sampler. Never parses disk summaries. */
  async telemetry(): Promise<DashboardTelemetry> {
    const projects = await (this.deps.telemetryProjects?.() ?? this.projects());
    const samples: DashboardTelemetry['samples'] = [];
    for (const p of projects)
      for (const run of p.store?.listRuns() ?? []) {
        if (run.status !== 'running' || run.archived) continue;
        const sample = currentTimedUsage(run.id);
        if (sample) samples.push({ projectId: p.id, runId: run.id, ...sample });
      }
    return { asOf: new Date(this.now()).toISOString(), samples };
  }

  async feed(filter: DashboardFeed['filter'], signal?: AbortSignal): Promise<DashboardFeed> {
    const now = this.now();
    const windowStart = now - WINDOW;
    const projection = await this.projection();
    const rows: DashboardFeedRow[] = [];
    const sources: DashboardFeedSource[] = [];
    if (filter !== 'github') {
      for (const run of projection.rows) {
        if (
          (run.status !== 'done' && run.status !== 'failed') ||
          run.autoResumeAt ||
          !run.finishedAt
        )
          continue;
        const at = Date.parse(run.finishedAt);
        if (!Number.isFinite(at) || at < windowStart || at > now) continue;
        rows.push({
          kind: 'task-result',
          key: `task:${run.projectId}:${run.id}`,
          at: new Date(at).toISOString(),
          run,
        });
      }
      for (const p of projection.coverage.projects)
        sources.push({
          key: `tasks:${p.projectId}`,
          state: p.state === 'complete' ? 'ready' : p.state === 'partial' ? 'stale' : 'unavailable',
          fetchedAt: new Date(now).toISOString(),
          truncated: false,
          ...(p.reason ? { reason: p.reason } : {}),
        });
    }
    if (filter !== 'tasks') {
      const github = await (this.deps.github ?? getDashboardGithub)(
        projection.projects,
        now,
        signal,
      );
      rows.push(
        ...github.rows.filter(
          (r) => Date.parse(r.at) >= windowStart && Date.parse(r.at) <= now,
        ),
      );
      sources.push(...github.sources);
    }
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key));
    // Name every source losing rows to the display cap, as well as upstream forge caps.
    const capped = new Set(
      rows
        .slice(60)
        .map((r) =>
          r.kind === 'task-result'
            ? `tasks:${r.run.projectId}`
            : `github:${r.repo}:${r.itemKind}`,
        ),
    );
    for (const source of sources) if (capped.has(source.key)) source.truncated = true;
    return {
      asOf: new Date(now).toISOString(),
      windowStart: new Date(windowStart).toISOString(),
      filter,
      rows: rows.slice(0, 60),
      sources,
      coverage: projection.coverage,
      truncated: rows.length > 60 || sources.some((s) => s.truncated),
    };
  }
}
