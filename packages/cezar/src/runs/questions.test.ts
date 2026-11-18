import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionKey, type TaskAskRecord } from '@open-mercato/cezar-contract';

import { reportPrClosed } from '../server/forge/pr-closed.ts';
import { ProjectContextError, type ProjectContext, type ProjectContexts } from '../server/project-context.ts';
import type { QuestionChange } from '../questions/types.ts';
import { createTaskQuestionProvider } from './questions.ts';
import { RunStore } from './store.ts';

const ask = (requestId: string, extra: Partial<TaskAskRecord> = {}): TaskAskRecord => ({
  requestId,
  askedAt: new Date().toISOString(),
  questions: [{ header: 'Scope', question: 'Which scope?', options: [{ label: 'A' }, { label: 'B' }] }],
  ...extra,
});

/** A stand-in for the run manager: the provider only forwards to these. */
const fakeManager = () => ({
  sendMessage: vi.fn(() => false),
  deferMessage: vi.fn(() => false),
  continueRun: vi.fn(() => ({ ok: false })),
  dismissAsk: vi.fn(),
});

describe('createTaskQuestionProvider', () => {
  let root: string;
  let built: Map<string, ProjectContext>;
  let builtListeners: Array<(ctx: ProjectContext) => void>;
  let registry: Array<{ id: string; root: string }>;
  let contexts: ProjectContexts;
  let disposers: Array<() => void>;

  const project = (id: string): ProjectContext => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const store = RunStore.open(join(dir, '.ai', 'cezar'));
    return { id, root: dir, dataDir: join(dir, '.ai', 'cezar'), store, manager: fakeManager() as never, automationStore: {} as never, launchKey: 'k' };
  };
  const build = (ctx: ProjectContext) => {
    built.set(ctx.id, ctx);
    for (const listener of builtListeners) listener(ctx);
  };
  const newRun = (ctx: ProjectContext, status: 'waiting' | 'running' = 'waiting') => {
    const id = ctx.store.createRun({ title: 'Fix login', workflow: 'quick-task', task: 't', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    ctx.store.updateRun(id, { status });
    return id;
  };
  const provider = () => {
    const p = createTaskQuestionProvider({ contexts, listProjects: async () => registry });
    disposers.push(() => p.dispose());
    return p;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-tq-'));
    built = new Map();
    builtListeners = [];
    registry = [];
    disposers = [];
    contexts = {
      ids: () => [...built.keys()],
      peek: (id: string) => built.get(id),
      context: async (id: string) => {
        const ctx = built.get(id);
        if (!ctx) throw new Error(`unknown project: ${id}`);
        return ctx;
      },
      onContextBuilt: (listener: (ctx: ProjectContext) => void) => {
        builtListeners.push(listener);
        return () => {};
      },
    } as unknown as ProjectContexts;
  });

  afterEach(() => {
    for (const dispose of disposers) dispose();
    for (const ctx of built.values()) ctx.store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists open questions and those closed in the last 7 days, sourced from the task', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('open', { cardId: 'plan', about: [{ pr: 7 }] }));
    ctx.store.recordTaskAsk(runId, ask('recent', { questions: [{ header: 'Other', question: '?', options: [{ label: 'a' }, { label: 'b' }] }] }));
    ctx.store.closeTaskAsks(runId, (a) => a.requestId === 'recent', { reason: 'dismissed', at: new Date().toISOString() });
    ctx.store.recordTaskAsk(runId, ask('old', { questions: [{ header: 'Old', question: '?', options: [{ label: 'a' }, { label: 'b' }] }] }));
    ctx.store.closeTaskAsks(runId, (a) => a.requestId === 'old', { reason: 'dismissed', at: new Date(Date.now() - 8 * 86_400_000).toISOString() });

    const items = await provider().list();
    expect(items.map((item) => item.key).sort()).toEqual([
      questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'open' }),
      questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'recent' }),
    ].sort());
    const open = items.find((item) => item.key.endsWith(':open'))!;
    expect(open).toMatchObject({
      source: { kind: 'task', projectId: 'alpha', runId, title: 'Fix login', status: 'waiting' },
      cardId: 'plan',
      about: [{ pr: 7 }],
      older: false,
    });
    expect(open.sourceTasks).toBeUndefined();
    expect(open.closed).toBeUndefined();
  });

  it('a session closed on its question reads as waiting, not failed', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('open'));
    ctx.store.updateRun(runId, { status: 'failed', awaitingAnswerSince: new Date().toISOString() });
    expect((await provider().list())[0]?.source).toMatchObject({ status: 'waiting' });
    ctx.store.updateRun(runId, { awaitingAnswerSince: undefined, idleClosedAt: new Date().toISOString() });
    expect((await provider().list())[0]?.source).toMatchObject({ status: 'waiting' });
    ctx.store.updateRun(runId, { idleClosedAt: undefined });
    expect((await provider().list())[0]?.source).toMatchObject({ status: 'failed' });
  });

  it('reads a project nobody opened from disk, without building its context', async () => {
    const cold = project('cold');
    const runId = newRun(cold);
    cold.store.recordTaskAsk(runId, ask('r1'));
    cold.store.flush();
    registry = [{ id: 'cold', root: cold.root }];
    const contextSpy = vi.spyOn(contexts, 'context');
    const items = await provider().list();
    expect(items.map((item) => item.key)).toEqual([questionKey({ kind: 'task', projectId: 'cold', runId, requestId: 'r1' })]);
    expect(contextSpy).not.toHaveBeenCalled();
  });

  it('answer() delivers with askRequestId, falling back to Continue; a closed question is 409', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('r1'));
    const manager = ctx.manager as unknown as ReturnType<typeof fakeManager>;
    manager.continueRun.mockImplementation(() => {
      ctx.store.closeTaskAsks(runId, () => true, { reason: 'answered', at: new Date().toISOString(), answer: 'A' });
      return { ok: true };
    });
    const key = questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'r1' });
    const result = await provider().answer(key, 'A');
    expect(manager.sendMessage).toHaveBeenCalledWith(runId, [{ type: 'text', text: 'A' }], { askRequestId: 'r1' });
    expect(manager.continueRun).toHaveBeenCalledWith(runId, { text: 'A', reply: { askRequestId: 'r1' } });
    expect(result).toMatchObject({ ok: true, item: { closed: { reason: 'answered', answer: 'A' } } });
    expect(await provider().answer(key, 'B')).toMatchObject({ ok: false, status: 409 });
    expect(await provider().answer(questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'nope' }), 'A')).toMatchObject({ ok: false, status: 404 });
    expect(await provider().answer('m:mgr:msg', 'A')).toMatchObject({ ok: false, status: 404 });
  });

  it('a project whose folder is gone answers 409, an unknown one 404', async () => {
    const missing = questionKey({ kind: 'task', projectId: 'gone', runId: 'run1', requestId: 'r1' });
    contexts.context = (async (id: string) => {
      throw new ProjectContextError(id === 'gone' ? 'missing-root' : 'unknown-project', id);
    }) as ProjectContexts['context'];
    expect(await provider().answer(missing, 'A')).toEqual({ ok: false, status: 409, error: 'project folder not found: gone' });
    expect(await provider().dismiss(missing)).toMatchObject({ ok: false, status: 409 });
    expect(await provider().answer(questionKey({ kind: 'task', projectId: 'nope', runId: 'run1', requestId: 'r1' }), 'A')).toMatchObject({ ok: false, status: 404 });
  });

  it('answer() answers 409 when no rung can take the message', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('r1'));
    const result = await provider().answer(questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'r1' }), 'A');
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it('dismiss() goes through the run manager and returns the closed item', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('r1'));
    const manager = ctx.manager as unknown as ReturnType<typeof fakeManager>;
    manager.dismissAsk.mockImplementation(() => {
      ctx.store.closeTaskAsks(runId, () => true, { reason: 'dismissed', at: new Date().toISOString() });
      return { ok: true, delivered: 'session' };
    });
    const result = await provider().dismiss(questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'r1' }));
    expect(manager.dismissAsk).toHaveBeenCalledWith(runId, 'r1', {});
    expect(result).toMatchObject({ ok: true, item: { closed: { reason: 'dismissed' } } });
    manager.dismissAsk.mockReturnValue({ ok: false, status: 409, error: 'question already closed' });
    expect(await provider().dismiss(questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'r1' }))).toMatchObject({ ok: false, status: 409 });
  });

  it('close() records the linked copy\'s close without delivering anything, and is a no-op when closed', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('r1'));
    const key = questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'r1' });
    const p = provider();
    const closed = { reason: 'dismissed' as const, at: new Date().toISOString(), detail: "in the manager's chat" };
    expect(await p.close(key, closed)).toMatchObject({ ok: true, item: { closed: { reason: 'dismissed' } } });
    expect(await p.close(key, { reason: 'retracted', at: new Date().toISOString() })).toMatchObject({ ok: true, item: { closed: { reason: 'dismissed' } } });
    const manager = ctx.manager as unknown as ReturnType<typeof fakeManager>;
    expect(manager.sendMessage).not.toHaveBeenCalled();
    expect(ctx.store.readEvents(runId).filter((event) => event.type === 'ask.closed')).toHaveLength(1);
  });

  it('onChange fires on open, flag and close, with closedItem on a close', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    const p = provider();
    const changes: QuestionChange[] = [];
    p.onChange((change) => changes.push(change));
    ctx.store.recordTaskAsk(runId, ask('r1'));
    ctx.store.flagTaskAsks(runId, () => true, { why: 'replied-in-chat', detail: 'x', since: new Date().toISOString() });
    ctx.store.closeTaskAsks(runId, () => true, { reason: 'retracted', at: new Date().toISOString() });
    expect(changes).toHaveLength(3);
    expect(changes[0]?.closedItem).toBeUndefined();
    expect(changes[1]?.closedItem).toBeUndefined();
    expect(changes[2]?.closedItem).toMatchObject({ key: questionKey({ kind: 'task', projectId: 'alpha', runId, requestId: 'r1' }), closed: { reason: 'retracted' } });
  });

  it('a project opened later is attached: its changes reach the listeners', async () => {
    const p = provider();
    const changes: QuestionChange[] = [];
    p.onChange((change) => changes.push(change));
    const ctx = project('late');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('r1'));
    expect(changes.length).toBeGreaterThanOrEqual(2); // the build, then the open
  });

  it('a deleted run reports its open questions closed as ended', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('r1'));
    const p = provider();
    const changes: QuestionChange[] = [];
    p.onChange((change) => changes.push(change));
    ctx.store.deleteRun(runId);
    expect(changes.map((change) => change.closedItem?.closed)).toEqual([expect.objectContaining({ reason: 'ended', detail: 'Task deleted' })]);
  });

  it('expires a card declaring {task} when that task finishes, in any opened project; failed does not', async () => {
    const asking = project('alpha');
    const other = project('beta');
    build(asking);
    build(other);
    const subject = newRun(other, 'running');
    const runId = newRun(asking);
    asking.store.recordTaskAsk(runId, ask('r1', { about: [{ task: `beta/${subject}` }] }));
    provider();
    other.store.updateRun(subject, { status: 'failed', awaitingAnswerSince: new Date().toISOString() });
    expect(asking.store.getRun(runId)?.asks?.[0]?.closed).toBeUndefined();
    other.store.updateRun(subject, { status: 'done' });
    expect(asking.store.getRun(runId)?.asks?.[0]?.closed).toMatchObject({ reason: 'expired', detail: 'Task done' });
  });

  it('expires a card declaring {pr} when that PR closes in the same repo; another repo or a verify read does not', async () => {
    const ctx = project('alpha');
    build(ctx);
    const runId = newRun(ctx);
    ctx.store.recordTaskAsk(runId, ask('r1', { about: [{ pr: 2891 }] }));
    ctx.store.recordTaskAsk(runId, ask('r2', { questions: [{ header: 'Mention', question: '?', options: [{ label: 'a' }, { label: 'b' }] }] }));
    provider();
    reportPrClosed('/somewhere/else', 2891, 'merged');
    reportPrClosed(ctx.root, 2891, 'merged', { verify: true });
    expect(ctx.store.getRun(runId)?.asks?.[0]?.closed).toBeUndefined();
    reportPrClosed(ctx.root, 2891, 'merged');
    expect(ctx.store.getRun(runId)?.asks?.[0]?.closed).toMatchObject({ reason: 'expired', detail: 'PR #2891 merged' });
    expect(ctx.store.getRun(runId)?.asks?.[1]?.closed).toBeUndefined(); // no `about`: never expires
  });

  it('owns only task keys', () => {
    const p = provider();
    expect(p.owns('r:alpha:run:req')).toBe(true);
    expect(p.owns('m:mgr:msg')).toBe(false);
  });
});
