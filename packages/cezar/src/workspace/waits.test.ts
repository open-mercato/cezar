import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaitEdge } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { isWaitRefusal, WaitResolver, type WaitProjectContext, type WaitRefusal } from './waits.ts';

/**
 * The workspace wait resolver on its own (spec `.ai/specs/2026-10-05-cross-task-waits.md`,
 * step 3): real `RunStore`s in temp dirs, a fake manager that records what it was asked to
 * deliver, and an explicit "built" set standing in for the project context map. Every row of the
 * spec's transitions table is here, plus the catch-up regression: a waiter whose context is built
 * only AFTER its target settled must still be woken.
 */
describe('WaitResolver', () => {
  const dirs: string[] = [];
  const delivered: Array<{ projectId: string; runId: string; text: string }> = [];
  let contexts: Map<string, WaitProjectContext>;
  let built: Set<string>;
  let resolver: WaitResolver;
  let deliverOk = true;

  const project = (id: string): WaitProjectContext => {
    const dir = mkdtempSync(join(tmpdir(), `cez-waits-${id}-`));
    dirs.push(dir);
    const ctx: WaitProjectContext = {
      id,
      store: RunStore.open(dir),
      manager: {
        deliverWaitNotice: (runId, text) => {
          delivered.push({ projectId: id, runId, text });
          return deliverOk;
        },
      },
    };
    contexts.set(id, ctx);
    return ctx;
  };

  const boot = (ids: string[]) => {
    resolver = new WaitResolver({
      canonical: async (id) => (id === 'default' ? 'web' : id),
      peek: (id) => (built.has(id) ? contexts.get(id) : undefined),
      build: async (id) => {
        const ctx = contexts.get(id);
        if (!ctx) throw Object.assign(new Error(`unknown project: ${id}`), { reason: 'unknown-project' });
        built.add(id);
        resolver.contextBuilt(id);
        return ctx;
      },
      listProjects: async () => [...contexts.keys()].map((id) => ({ id, root: '/nowhere', status: 'ok' })),
    });
    for (const id of ids) {
      built.add(id);
      resolver.contextBuilt(id);
    }
  };

  const runIn = (ctx: WaitProjectContext, title: string, status: RunRecord['status'] = 'running'): RunRecord => {
    const run = ctx.store.createRun({ title, task: title, workflow: 'quick-task', steps: [] });
    ctx.store.updateRun(run.id, { status });
    return ctx.store.getRun(run.id)!;
  };

  const settle = (ctx: WaitProjectContext, runId: string, status: RunRecord['status'] = 'done') => {
    ctx.store.updateRun(runId, { status });
    ctx.store.notifySettled(runId);
  };

  const edgesOf = (ctx: WaitProjectContext, runId: string): WaitEdge[] => ctx.store.getRun(runId)?.waits ?? [];

  const pendingEdge = async (waiter: [WaitProjectContext, RunRecord], target: [string | undefined, string], timeoutMinutes?: number): Promise<WaitEdge> => {
    const result = await resolver.declare(waiter[0].id, waiter[1].id, {
      target: { ...(target[0] ? { projectId: target[0] } : {}), runId: target[1] },
      ...(timeoutMinutes ? { timeoutMinutes } : {}),
    }, 'agent');
    if (isWaitRefusal(result) || result.kind !== 'pending') throw new Error(`expected a pending edge, got ${JSON.stringify(result)}`);
    return result.edge;
  };

  const refusal = async (waiter: [WaitProjectContext, RunRecord], target: [string | undefined, string]): Promise<WaitRefusal> => {
    const result = await resolver.declare(waiter[0].id, waiter[1].id, {
      target: { ...(target[0] ? { projectId: target[0] } : {}), runId: target[1] },
    }, 'agent');
    if (!isWaitRefusal(result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
    return result;
  };

  beforeEach(() => {
    contexts = new Map();
    built = new Set();
    delivered.length = 0;
    deliverOk = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    resolver?.dispose();
    for (const ctx of contexts.values()) ctx.store.flush();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('declares a cross-project edge and wakes the waiter with the outcome when the target settles', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'Build the export page');
    const target = runIn(api, 'Add export endpoint');
    const edge = await pendingEdge([web, waiter], ['api', target.id.slice(0, 8)]);
    expect(edge).toMatchObject({ target: { projectId: 'api', runId: target.id }, targetTitle: 'Add export endpoint', origin: 'agent', state: 'pending' });
    expect(Date.parse(edge.deadline) - Date.parse(edge.createdAt)).toBe(24 * 60 * 60_000);
    expect(edgesOf(web, waiter.id)).toHaveLength(1);

    api.store.updateRun(target.id, { pullRequestUrl: 'https://github.com/o/r/pull/7', costUsd: 1.25 });
    settle(api, target.id, 'review');
    const [resolved] = edgesOf(web, waiter.id);
    expect(resolved).toMatchObject({ state: 'settled', outcome: { status: 'review', prUrl: 'https://github.com/o/r/pull/7', costUsd: 1.25 } });
    expect(resolved?.resolvedAt).toBeDefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.runId).toBe(waiter.id);
    expect(delivered[0]!.text).toContain('has settled — review');
    expect(delivered[0]!.text).toContain('https://github.com/o/r/pull/7');
    expect(delivered[0]!.text).toContain('no longer waiting');
  });

  it('answers an already-settled target at once and records nothing', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'done already', 'done');
    const result = await resolver.declare('web', waiter.id, { target: { runId: target.id } }, 'agent');
    expect(result).toMatchObject({ kind: 'settled', outcome: { status: 'done', title: 'done already', target: { projectId: 'web', runId: target.id } } });
    expect(edgesOf(web, waiter.id)).toEqual([]);
  });

  it('refuses self-waits, unknown projects and runs, ambiguous ids, settled waiters, the cap and cycles', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const a = runIn(web, 'a');
    const b = runIn(api, 'b');
    expect((await refusal([web, a], [undefined, a.id])).status).toBe(400);
    expect((await refusal([web, a], ['nope', b.id])).status).toBe(404);
    expect((await refusal([web, a], ['api', 'zzzzzzzz'])).status).toBe(404);

    const done = runIn(web, 'finished', 'done');
    expect((await resolver.declare('web', done.id, { target: { projectId: 'api', runId: b.id } }, 'agent') as WaitRefusal).status).toBe(409);

    // A waits B (across projects), B waits A → the second declaration names the loop.
    await pendingEdge([web, a], ['api', b.id]);
    const loop = await refusal([api, b], ['web', a.id]);
    expect(loop.status).toBe(409);
    expect(loop.error).toContain('cycle');
    expect(loop.error).toContain(`api/${b.id.slice(0, 8)}`);
    expect(loop.error).toContain(`web/${a.id.slice(0, 8)}`);

    // Re-declaring the same target answers the existing edge rather than a duplicate.
    const again = await pendingEdge([web, a], ['api', b.id]);
    expect(edgesOf(web, a.id)).toHaveLength(1);
    expect(again.id).toBe(edgesOf(web, a.id)[0]!.id);

    // The cap: four pending edges, the fifth is refused.
    for (let i = 0; i < 3; i += 1) await pendingEdge([web, a], ['api', runIn(api, `t${i}`).id]);
    const capped = await refusal([web, a], ['api', runIn(api, 'one more').id]);
    expect(capped.status).toBe(409);
    expect(capped.error).toContain('the cap is 4');
  });

  it('names the candidates when an id prefix is ambiguous', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    runIn(web, 'first');
    runIn(web, 'second');
    // Every id shares the empty prefix — the shortest way to get several candidates. (The route's
    // schema requires one character; the resolver's own rule is what is under test here.)
    const result = await resolver.declare('web', waiter.id, { target: { runId: '' } }, 'agent');
    expect(isWaitRefusal(result) && result.status).toBe(404);
    expect(isWaitRefusal(result) && result.error).toContain('ambiguous');
    expect(isWaitRefusal(result) && result.error).toContain('"first"');
  });

  it('resolves target-deleted when the target run is deleted', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'target');
    await pendingEdge([web, waiter], [undefined, target.id]);
    web.store.deleteRun(target.id);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('target-deleted');
    expect(delivered[0]?.text).toContain('was deleted');
  });

  it('resolves target-unavailable when the target project is removed', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(api, 'target');
    await pendingEdge([web, waiter], ['api', target.id]);
    built.delete('api');
    resolver.projectRemoved('api');
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('target-unavailable');
    expect(delivered[0]?.text).toContain('project api was removed');
  });

  it('resolves timed-out at the deadline, naming the target’s status', async () => {
    vi.useFakeTimers();
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'slow target');
    await pendingEdge([web, waiter], [undefined, target.id], 1);
    vi.advanceTimersByTime(59_000);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('pending');
    vi.advanceTimersByTime(2_000);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('timed-out');
    expect(delivered[0]?.text).toContain('timed out after 1 min; the target is still running');
  });

  it('cancels on request and tells the waiter', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'target');
    const edge = await pendingEdge([web, waiter], [undefined, target.id]);
    const result = resolver.cancel('web', waiter.id, edge.id);
    expect(result).toMatchObject({ edge: { id: edge.id, state: 'cancelled' } });
    expect(delivered[0]?.text).toContain('The user stopped your wait');
    expect((resolver.cancel('web', waiter.id, edge.id) as WaitRefusal).status).toBe(409);
    expect((resolver.cancel('web', waiter.id, 'nope') as WaitRefusal).status).toBe(404);
    // A later settle of the target does nothing more.
    settle(web, target.id);
    expect(delivered).toHaveLength(1);
  });

  it('resolves waiter-ended, with no delivery, when the WAITER settles or is deleted', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'target');
    await pendingEdge([web, waiter], [undefined, target.id]);
    settle(web, waiter.id, 'done');
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('waiter-ended');
    expect(delivered).toEqual([]);
    // Deleting a waiter just drops it from the index.
    const other = runIn(web, 'other waiter');
    await pendingEdge([web, other], [undefined, target.id]);
    web.store.deleteRun(other.id);
    settle(web, target.id);
    expect(delivered).toEqual([]);
  });

  it('a user-declared wait tells the waiter who asked', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'target');
    const result = await resolver.declare('web', waiter.id, { target: { runId: target.id } }, 'user');
    expect(result).toMatchObject({ kind: 'pending', edge: { origin: 'user' } });
    expect(delivered[0]?.text).toContain('The user asked you to wait for "target"');
  });

  it('notes an undeliverable outcome on the record instead of losing it', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'target');
    await pendingEdge([web, waiter], [undefined, target.id]);
    deliverOk = false;
    settle(web, target.id);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('settled');
    const notes = web.store.readEvents(waiter.id).map((event) => String((event as { message?: unknown }).message ?? ''));
    expect(notes.some((note) => note.includes('could not be delivered'))).toBe(true);
  });

  // ---- the catch-up ------------------------------------------------------------------------

  it('REGRESSION: a waiter whose context is built after its target settled is still woken', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(api, 'target');
    await pendingEdge([web, waiter], ['api', target.id]);
    // The waiter's project goes cold (process restart: only the target project is built).
    resolver.dispose();
    built.clear();
    boot(['api']);
    settle(api, target.id, 'failed');
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('pending');
    expect(delivered).toEqual([]);
    // Opening the waiter's project runs the catch-up.
    built.add('web');
    resolver.contextBuilt('web');
    expect(edgesOf(web, waiter.id)[0]).toMatchObject({ state: 'settled', outcome: { status: 'failed' } });
    expect(delivered[0]?.text).toContain('has settled — failed');
  });

  it('catch-up builds an unbuilt target project and resolves an expired deadline at once', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(api, 'target');
    const edge = await pendingEdge([web, waiter], ['api', target.id]);
    resolver.dispose();
    built.clear();
    // The deadline passed while cezar was down.
    web.store.updateRun(waiter.id, { waits: [{ ...edge, deadline: new Date(Date.now() - 1000).toISOString() }] });
    boot(['web']);
    expect(built.has('api')).toBe(false);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('timed-out');

    // And with a live deadline the target project gets built so the target can progress.
    const second = runIn(web, 'second waiter');
    web.store.updateRun(second.id, { waits: [{ ...edge, id: 'w2', deadline: new Date(Date.now() + 60_000).toISOString() }] });
    resolver.dispose();
    built.clear();
    boot(['web']);
    await vi.waitFor(() => expect(built.has('api')).toBe(true));
    settle(api, target.id);
    expect(edgesOf(web, second.id)[0]?.state).toBe('settled');
  });

  it('catch-up resolves a settled waiter’s leftover edges as waiter-ended', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'target');
    await pendingEdge([web, waiter], [undefined, target.id]);
    resolver.dispose();
    built.clear();
    web.store.updateRun(waiter.id, { status: 'done' });
    boot(['web']);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('waiter-ended');
    expect(delivered).toEqual([]);
  });

  it('dispose leaves every edge pending on its record', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'target');
    await pendingEdge([web, waiter], [undefined, target.id]);
    resolver.dispose();
    settle(web, target.id);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('pending');
  });

  it('trims resolved history to the newest twenty, never a pending edge', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    for (let i = 0; i < 22; i += 1) {
      const target = runIn(web, `t${i}`);
      await pendingEdge([web, waiter], [undefined, target.id]);
      settle(web, target.id);
    }
    const keepPending = runIn(web, 'still running');
    await pendingEdge([web, waiter], [undefined, keepPending.id]);
    const edges = edgesOf(web, waiter.id);
    expect(edges.filter((e) => e.state === 'settled')).toHaveLength(20);
    expect(edges.filter((e) => e.state === 'pending')).toHaveLength(1);
    expect(edges.find((e) => e.targetTitle === 't0')).toBeUndefined();
  });

  // ---- review fixes ----------------------------------------------------------------------------

  it('refuses a dispatched task waiting on its own ancestor — a deadlock the wait graph cannot see', async () => {
    const web = project('web');
    boot(['web']);
    const root = runIn(web, 'root');
    const child = runIn(web, 'child');
    const grandchild = runIn(web, 'grandchild');
    web.store.updateRun(child.id, { dispatch: { rootRunId: root.id, parentRunId: root.id } });
    web.store.updateRun(grandchild.id, { dispatch: { rootRunId: root.id, parentRunId: child.id } });
    const direct = await refusal([web, web.store.getRun(child.id)!], [undefined, root.id]);
    expect(direct.status).toBe(409);
    expect(direct.error).toContain('deadlock');
    expect((await refusal([web, web.store.getRun(grandchild.id)!], [undefined, root.id])).status).toBe(409);
    // The other direction is fine: a parent may wait on its own child.
    await pendingEdge([web, root], [undefined, child.id]);
  });

  it('re-checks the waiter after a slow project build — a waiter that settled meanwhile records nothing', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(api, 'target');
    // The build of `api` takes a while; the waiter finishes during it.
    const slow = new WaitResolver({
      canonical: async (id) => id,
      peek: (id) => (built.has(id) ? contexts.get(id) : undefined),
      build: async (id) => {
        web.store.updateRun(waiter.id, { status: 'done' });
        built.add(id);
        return contexts.get(id)!;
      },
      listProjects: async () => [],
    });
    try {
      const result = await slow.declare('web', waiter.id, { target: { projectId: 'api', runId: target.id } }, 'agent');
      expect(isWaitRefusal(result) && result.status).toBe(409);
      expect(web.store.getRun(waiter.id)?.waits).toBeUndefined();
    } finally {
      slow.dispose();
    }
  });

  it('keeps tracking a CREATED task after its wait was stopped, and records its settle for the budget', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'creator');
    const target = runIn(api, 'created elsewhere');
    // A created edge, as the create path records it.
    const edge = await pendingEdge([web, waiter], ['api', target.id]);
    web.store.updateRun(waiter.id, { waits: [{ ...edge, created: true, budgetUsd: 8 }] });
    resolver.contextBuilt('web');
    api.store.updateRun(target.id, { costUsd: 1 });
    resolver.cancel('web', waiter.id, edge.id);
    expect(edgesOf(web, waiter.id)[0]).toMatchObject({ state: 'cancelled', outcome: { status: 'running', costUsd: 1 } });
    delivered.length = 0;
    api.store.updateRun(target.id, { costUsd: 3 });
    settle(api, target.id, 'review');
    expect(edgesOf(web, waiter.id)[0]).toMatchObject({ state: 'cancelled', outcome: { status: 'review', costUsd: 3 } });
    // Silently: the wait is long over.
    expect(delivered).toEqual([]);
  });

  it('never trims a created edge out of the history — it is the only record of what it cost', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const first = runIn(web, 'created first');
    const edge = await pendingEdge([web, waiter], [undefined, first.id]);
    web.store.updateRun(waiter.id, { waits: [{ ...edge, created: true, budgetUsd: 2 }] });
    resolver.dispose();
    built.clear();
    boot(['web']);
    settle(web, first.id);
    for (let i = 0; i < 22; i += 1) {
      const t = runIn(web, `t${i}`);
      await pendingEdge([web, waiter], [undefined, t.id]);
      settle(web, t.id);
    }
    const edges = edgesOf(web, waiter.id);
    expect(edges.find((e) => e.targetTitle === 'created first')).toMatchObject({ created: true, state: 'settled' });
    expect(edges.filter((e) => !e.created)).toHaveLength(20);
  });

  // #1290 merged into the waits feature: a `failed` run whose session closed on an unanswered
  // CEZ:ASK carries `awaitingAnswerSince` and is "needs you", not an outcome.
  const leaveOnQuestion = (ctx: WaitProjectContext, runId: string) => {
    ctx.store.updateRun(runId, { status: 'failed', error: 'the session closed before the question was answered', awaitingAnswerSince: new Date().toISOString() });
    ctx.store.notifySettled(runId);
  };

  it('REGRESSION: a target left on an unanswered question does not settle the wait — its answer does', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(api, 'asks the user');
    await pendingEdge([web, waiter], ['api', target.id]);
    leaveOnQuestion(api, target.id);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('pending');
    expect(delivered).toEqual([]);
    // The user answers: Continue reopens it, and its real settle wakes the waiter.
    api.store.updateRun(target.id, { status: 'running' });
    settle(api, target.id, 'review');
    expect(edgesOf(web, waiter.id)[0]).toMatchObject({ state: 'settled', outcome: { status: 'review' } });
    expect(delivered[0]?.text).toContain('has settled — review');
  });

  it('REGRESSION: a re-wait on a target left on a question waits rather than answering "settled" at once', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'asks the user');
    leaveOnQuestion(web, target.id);
    const edge = await pendingEdge([web, waiter], [undefined, target.id]);
    expect(edge.state).toBe('pending');
  });

  it('archiving a target left on a question settles the wait with its final failed outcome', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(web, 'asks the user');
    await pendingEdge([web, waiter], [undefined, target.id]);
    leaveOnQuestion(web, target.id);
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('pending');
    web.store.setArchived(target.id, true);
    expect(edgesOf(web, waiter.id)[0]).toMatchObject({ state: 'settled', outcome: { status: 'failed' } });
    expect(delivered).toHaveLength(1);
  });

  it('a Finish or cancel of a target left on a question settles the wait', async () => {
    const web = project('web');
    boot(['web']);
    const waiter = runIn(web, 'waiter');
    const first = runIn(web, 'finished by the user');
    const second = runIn(web, 'cancelled by the user');
    await pendingEdge([web, waiter], [undefined, first.id]);
    await pendingEdge([web, waiter], [undefined, second.id]);
    leaveOnQuestion(web, first.id);
    leaveOnQuestion(web, second.id);
    web.store.updateRun(first.id, { status: 'done' });
    web.store.updateRun(second.id, { status: 'cancelled' });
    const states = Object.fromEntries(edgesOf(web, waiter.id).map((e) => [e.targetTitle, e.outcome?.status]));
    expect(states).toEqual({ 'finished by the user': 'done', 'cancelled by the user': 'cancelled' });
  });

  it('the catch-up keeps an edge on a target left on a question pending', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'waiter');
    const target = runIn(api, 'asks the user');
    await pendingEdge([web, waiter], ['api', target.id]);
    leaveOnQuestion(api, target.id);
    resolver.contextBuilt('web');
    resolver.contextBuilt('api');
    expect(edgesOf(web, waiter.id)[0]?.state).toBe('pending');
  });

  it('a CREATED target left on a question keeps its reservation until it really settles', async () => {
    const web = project('web');
    const api = project('api');
    boot(['web', 'api']);
    const waiter = runIn(web, 'creator');
    const target = runIn(api, 'created elsewhere');
    const edge = await pendingEdge([web, waiter], ['api', target.id]);
    web.store.updateRun(waiter.id, { waits: [{ ...edge, created: true, budgetUsd: 8 }] });
    resolver.contextBuilt('web');
    resolver.cancel('web', waiter.id, edge.id);
    leaveOnQuestion(api, target.id);
    expect(edgesOf(web, waiter.id)[0]?.outcome?.status).toBe('running');
    api.store.updateRun(target.id, { status: 'running' });
    settle(api, target.id, 'done');
    expect(edgesOf(web, waiter.id)[0]?.outcome?.status).toBe('done');
  });
});
