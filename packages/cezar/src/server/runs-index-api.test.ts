import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunsIndexResponse } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import { __seedRefStatusCacheForTests } from './forge/github.ts';

/**
 * `GET /api/v1/workspace/runs-index` — the ⌘K palette's cross-project task finder.
 *
 * The behaviours worth pinning are the ones a future change could quietly break: that a project
 * this process has never opened still contributes rows (read off disk), that reading them does
 * NOT build a context — which would prune worktrees and resume agents — and that the wire shape
 * stays slim, because the whole reason this route exists instead of N `/runs` calls is that
 * `RunRecord` carries `steps[]`.
 */

/** A stored record, written straight to a cold project's `runs.json`. */
function storedRun(over: Record<string, unknown> & { id: string; title: string }) {
  return {
    workflow: 'build',
    task: 'do the thing',
    status: 'done',
    createdAt: '2026-07-14T10:00:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [{ id: 's1', name: 'work', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }],
    ...over,
  };
}

describe('workspace runs index API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-runs-index-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-runs-index-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-runs-index-other-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const getIndex = async (over: Partial<ServerDeps> = {}): Promise<RunsIndexResponse> => {
    const res = await apiRequest(makeApp(over), '/api/v1/workspace/runs-index');
    expect(res.status).toBe(200);
    return (await res.json()) as RunsIndexResponse;
  };

  /** Give `root` a `runs.json` without ever opening a store on it — a genuinely COLD project. */
  const seedColdProject = (root: string, runs: unknown[]) => {
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(runs), 'utf8');
  };

  it('answers an empty index for an empty registry — never a 404', async () => {
    const body = await getIndex();
    expect(body).toEqual({ runs: [], perProjectLimit: 200, truncated: [], referenceStatuses: {} });
  });

  it('merges the boot project’s live store with a cold project read off disk, newest first', async () => {
    const boot = await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    const live = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    store.updateRun(live.id, { createdAt: '2026-07-10T10:00:00Z' });
    seedColdProject(otherRoot, [
      storedRun({ id: 'cold-1', title: 'Cold task', createdAt: '2026-07-15T10:00:00Z' }),
    ]);

    const body = await getIndex();

    expect(body.runs.map((run) => run.id)).toEqual(['cold-1', live.id]);
    expect(body.runs.map((run) => run.projectId)).toEqual([other.id, boot.id]);
    expect(body.truncated).toEqual([]);
  });

  it('never builds a project context — a search must not resume agents', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    seedColdProject(otherRoot, [storedRun({ id: 'cold-1', title: 'Cold task' })]);
    const contexts = new ProjectContexts({ listProjects });

    const body = await getIndex({ contexts });

    expect(body.runs.map((run) => run.id)).toEqual(['cold-1']);
    // The row came from disk, and the project is still unopened: no store, no manager, no
    // `recover()`. This is the guarantee the whole read-only reader exists to provide.
    expect(contexts.peek(other.id)).toBeUndefined();
    expect(contexts.ids()).toEqual([]);
    contexts.disposeAll();
  });

  it('sends the slim row — no steps, and optional keys absent rather than null', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'cold-1',
        title: 'raw title',
        titleSummary: 'Nice summary',
        titleOrigin: 'auto',
        finishedAt: '2026-07-14T11:00:00Z',
        seenAt: '2026-07-14T12:00:00Z',
      }),
    ]);

    const body = await getIndex();

    const [row] = body.runs;
    expect(row).toEqual({
      projectId: expect.any(String),
      id: 'cold-1',
      title: 'raw title',
      titleSummary: 'Nice summary',
      titleOrigin: 'auto',
      status: 'done',
      createdAt: '2026-07-14T10:00:00Z',
      finishedAt: '2026-07-14T11:00:00Z',
      // The read receipt and the archive flag ride along so the palette can compute `isUnread`
      // for a project it is not standing in — the same inputs the Tasks badge reads.
      seenAt: '2026-07-14T12:00:00Z',
      archived: false,
      // The global Tasks page's own columns: always-present workflow, plus branch/startedAt
      // when the run has them (this one does not — see the absent-key assertions below).
      workflow: 'build',
    });
    // The fat keys neither consumer has a use for never reach the wire — `workflow` rides along
    // as a plain string, `steps[]` and `workflowDef` (the expensive half) do not.
    expect(row).not.toHaveProperty('steps');
    expect(row).not.toHaveProperty('task');
    expect(row).not.toHaveProperty('workflowDef');
    // An absent optional is absent, not `undefined` — the wire has no such value.
    expect(Object.keys(row!)).not.toContain('activity');
    expect(Object.keys(row!)).not.toContain('branch');
    expect(Object.keys(row!)).not.toContain('startedAt');
    // …including every tracker-reference input and every usage field: an untracked, never-run
    // task carries none of them.
    for (const key of [
      'pullRequestUrl',
      'referencedPullRequestUrl',
      'prNumber',
      'issueNumber',
      'referencedIssueUrl',
      'markerRefs',
      'costUsd',
      'peakRssBytes',
      'peakProcCount',
      'usage',
    ]) {
      expect(Object.keys(row!), key).not.toContain(key);
    }
  });

  it('carries cost and the persisted usage peaks the cross-project table paints', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'measured',
        title: 'Measured',
        costUsd: 0.31,
        peakRssBytes: 943718400,
        peakProcCount: 4,
      }),
    ]);

    const body = await getIndex();
    const row = body.runs.find((entry) => entry.id === 'measured');

    expect(row).toMatchObject({ costUsd: 0.31, peakRssBytes: 943718400, peakProcCount: 4 });
    // The LIVE sample is not persisted, so a cold project's row never carries one.
    expect(Object.keys(row!)).not.toContain('usage');
  });

  it('carries the tracker-reference inputs so a cross-project row can show its PR/issue chip', async () => {
    // Verbatim, not pre-resolved: the rule that picks between them (#407, #526) lives in the
    // cockpit's `taskReference()`, and resolving it a second time here would be a second rule.
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'tracked',
        title: 'Ship it',
        branch: 'feat/ship',
        startedAt: '2026-07-14T10:00:05Z',
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        prNumber: 42,
        markerRefs: { pr: 42 },
      }),
    ]);

    const body = await getIndex();
    const row = body.runs.find((entry) => entry.id === 'tracked');

    expect(row).toMatchObject({
      branch: 'feat/ship',
      startedAt: '2026-07-14T10:00:05Z',
      pullRequestUrl: 'https://github.com/acme/demo/pull/42',
      prNumber: 42,
      markerRefs: { pr: 42 },
    });
    // Still the slim row — the expensive half never rides along.
    expect(row).not.toHaveProperty('steps');
    expect(row).not.toHaveProperty('workflowDef');
  });

  it('includes archived runs — findable from a project is findable from anywhere', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({ id: 'live', title: 'Live', createdAt: '2026-07-14T11:00:00Z' }),
      storedRun({ id: 'filed', title: 'Archived', archived: true, createdAt: '2026-07-14T10:00:00Z' }),
    ]);

    const body = await getIndex();

    // The project-scoped `GET /runs` carries archived runs, so the cross-project finder must
    // too — otherwise a task disappears from search the moment you switch away from it.
    expect(body.runs.map((run) => run.id)).toEqual(['live', 'filed']);
  });

  it('caps each project and names it in `truncated`, so no cap is silent', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    // 210 > the 200 cap. Ids sort with the timestamps so the newest survivors are predictable.
    seedColdProject(
      otherRoot,
      Array.from({ length: 210 }, (_, i) => {
        const n = String(i).padStart(3, '0');
        const hour = String(10 + Math.floor(i / 60)).padStart(2, '0');
        const minute = String(i % 60).padStart(2, '0');
        return storedRun({ id: `r-${n}`, title: `Task ${n}`, createdAt: `2026-07-14T${hour}:${minute}:00Z` });
      }),
    );

    const body = await getIndex();

    expect(body.runs).toHaveLength(200);
    expect(body.perProjectLimit).toBe(200);
    expect(body.truncated).toEqual([other.id]);
    // The NEWEST 200 survived, not the first 200 in file order.
    expect(body.runs[0]?.id).toBe('r-209');
    expect(body.runs.at(-1)?.id).toBe('r-010');
  });

  it('carries `autoResumeAt`, so a usage-limit park does not read as a failure', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'parked',
        title: 'Waiting out the limit',
        status: 'failed',
        finishedAt: '2026-07-14T11:00:00Z',
        autoResumeAt: '2026-07-14T15:00:00Z',
      }),
    ]);

    const body = await getIndex();

    // `deriveAttention` and `isUnread` both read this field. Dropping it from the slim row would
    // make the palette paint a red "failed" dot on work that is merely waiting for its slot.
    expect(body.runs[0]).toMatchObject({
      id: 'parked',
      status: 'failed',
      autoResumeAt: '2026-07-14T15:00:00Z',
    });
  });

  it('reads a crashed process’s `running` row as interrupted, exactly as opening it would', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [storedRun({ id: 'ghost', title: 'Ghost', status: 'running' })]);

    const body = await getIndex();

    // Shared with `RunStore.open` through `reconcileLoadedRun`: a task cannot read as running in
    // the palette and failed the moment it is opened.
    expect(body.runs[0]?.status).toBe('failed');
  });

  it('skips a project whose folder is gone and degrades a corrupt index to no rows', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    mkdirSync(join(otherRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(otherRoot, '.ai/cezar/runs.json'), '{ not json', 'utf8');
    const live = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });

    const body = await getIndex();

    // One unreadable project costs its own rows, never the whole workspace's search.
    expect(body.runs.map((run) => run.id)).toEqual([live.id]);
  });

  /**
   * Statuses ride along with the rows that carry the references, so the chips are coloured in the
   * same paint as the table rather than a round trip later. The rule that makes it free — and
   * therefore safe on a route the palette hits — is that it reads the ref-status cache and NEVER
   * asks the forge.
   */
  describe('reference statuses', () => {
    it('ships an empty map when the server has looked nothing up', async () => {
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Has a PR', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, { pullRequestUrl: 'https://github.com/acme/demo/pull/42' });

      const body = await getIndex();

      // Present but empty — never absent, so a consumer can read it without a guard, and never
      // invented, so a cold reference stays "nothing known" rather than a guessed status.
      expect(body.referenceStatuses).toEqual({});
      expect(body.runs.some((row) => row.id === run.id)).toBe(true);
    });

    it('ships what the cache holds, keyed by project', async () => {
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Has a PR', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, {
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        issueNumber: 7,
      });
      // Warm the cache the way the lazy route would have.
      __seedRefStatusCacheForTests(realpathSync(repoRoot), [
        [42, { kind: 'pr', status: 'merged' }],
        [7, { kind: 'issue', status: 'open' }],
      ]);

      const body = await getIndex();

      const project = Object.keys(body.referenceStatuses)[0]!;
      expect(body.referenceStatuses[project]).toEqual({ prs: { 42: 'merged' }, issues: { 7: 'open' } });
    });

    it('looks up every number a run MENTIONS, not just the one its chip will show', async () => {
      // Which reference is displayed is the cockpit's rule (#407, #526) and is deliberately not
      // re-derived here. A cache read costs nothing per number, so the superset is free — and it
      // is what lets the client apply its own rule to whatever it gets.
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Several', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, {
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        referencedPullRequestUrl: 'https://github.com/acme/demo/pull/40',
        referencedIssueUrl: 'https://github.com/acme/demo/issues/12',
      });
      __seedRefStatusCacheForTests(realpathSync(repoRoot), [
        [42, { kind: 'pr', status: 'merged' }],
        [40, { kind: 'pr', status: 'ready' }],
        [12, { kind: 'issue', status: 'completed' }],
      ]);

      const body = await getIndex();

      const project = Object.keys(body.referenceStatuses)[0]!;
      expect(body.referenceStatuses[project]).toEqual({
        prs: { 40: 'ready', 42: 'merged' },
        issues: { 12: 'completed' },
      });
    });
  });
});
