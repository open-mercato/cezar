import { statSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseQuestionKey,
  QUESTIONS_CLOSED_WINDOW_DAYS,
  questionKey,
  type QuestionClosed,
  type QuestionItem,
  type TaskAskRecord,
} from '@open-mercato/cezar-contract';

import { ProjectContextError, type ProjectContext, type ProjectContexts } from '../server/project-context.ts';
import { onPrClosed } from '../server/forge/pr-closed.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import type { QuestionChange, QuestionProvider, QuestionResult } from '../questions/types.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import type { RunRecord, RunStore } from './store.ts';
import { ASK_ENDING_STATUSES, isAboutPr, isAboutTask, isOpenAsk, QUESTION_ALREADY_CLOSED } from './task-asks.ts';

export interface TaskQuestionDeps {
  contexts: ProjectContexts;
  /** Registered projects (id, root). Default: the workspace registry, read without probing. */
  listProjects?: () => Promise<ReadonlyArray<{ id: string; root: string }>>;
  /** A cold project's runs, read-only. Default: `readRunIndexFromDisk`. */
  readRuns?: (dataDir: string) => RunRecord[];
  now?: () => number;
  /** The provider gate the messages and Continue routes run: a refusal text, or null to proceed. */
  providerBlocked?: (ctx: ProjectContext, run: RunRecord) => Promise<string | null | undefined>;
}

const DAY_MS = 86_400_000;
const PROJECTS_TTL_MS = 30_000;

/**
 * Every project's task questions for the Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`).
 *
 * Coverage without waking projects: a built context is read from its live store; a registered
 * project nobody opened yet is read from its `runs.json` through the read-only index reader, re-read
 * only when the file's mtime moves. Building a context recovers runs and can restart agents, so
 * only an answer or a dismiss (acting on that project anyway) builds one. A cold project has no
 * session, so its questions cannot change until it is opened, which is when `onContextBuilt`
 * attaches the live listeners.
 */
/** A session closed on its open question (idle, or awaiting the answer) is still waiting on the user,
 *  not a failure: Continue answers it (#2286). */
const sourceStatus = (run: RunRecord): string =>
  run.status === 'failed' && (run.awaitingAnswerSince !== undefined || run.idleClosedAt !== undefined) ? 'waiting' : run.status;

export function createTaskQuestionProvider(deps: TaskQuestionDeps): QuestionProvider & { dispose(): void } {
  const { contexts } = deps;
  const now = deps.now ?? Date.now;
  const readRuns = deps.readRuns ?? readRunIndexFromDisk;
  const listProjects = deps.listProjects ?? (async () => (await loadWorkspaceConfig()).projects);
  const listeners = new Set<(change: QuestionChange) => void>();
  const cleanups: Array<() => void> = [];
  const attached = new WeakSet<RunStore>();
  /** Last open asks per run, so a deletion can still report what it closed. */
  const lastOpen = new Map<string, { projectId: string; run: RunRecord }>();
  /** Whether each run was already final, so the about-task sweep runs on the transition only. */
  const wasFinal = new Map<string, boolean>();
  let projectsCache: { at: number; list: ReadonlyArray<{ id: string; root: string }> } | undefined;
  const coldCache = new Map<string, { mtimeMs: number; runs: RunRecord[] }>();

  const fire = (change: QuestionChange) => {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch {
        // a listener's failure is its own
      }
    }
  };

  const notFound: QuestionResult = { ok: false, status: 404, error: 'question not found' };
  const alreadyClosed: QuestionResult = { ok: false, status: 409, error: QUESTION_ALREADY_CLOSED };

  const builtContexts = (): ProjectContext[] =>
    contexts.ids().map((id) => contexts.peek(id)).filter((ctx): ctx is ProjectContext => ctx !== undefined);

  const item = (projectId: string, run: RunRecord, ask: TaskAskRecord): QuestionItem => ({
    key: questionKey({ kind: 'task', projectId, runId: run.id, requestId: ask.requestId }),
    source: { kind: 'task', projectId, runId: run.id, title: run.titleSummary ?? run.title, status: sourceStatus(run) },
    ...(ask.cardId ? { cardId: ask.cardId } : {}),
    askedAt: ask.askedAt,
    questions: ask.questions,
    ...(ask.about ? { about: ask.about } : {}),
    ...(ask.stale ? { stale: ask.stale } : {}),
    older: false,
    ...(ask.closed ? { closed: ask.closed } : {}),
  });

  const itemsOf = (projectId: string, runs: readonly RunRecord[]): QuestionItem[] => {
    const since = now() - QUESTIONS_CLOSED_WINDOW_DAYS * DAY_MS;
    const out: QuestionItem[] = [];
    for (const run of runs) {
      for (const ask of run.asks ?? []) {
        if (ask.closed && Date.parse(ask.closed.at) < since) continue;
        out.push(item(projectId, run, ask));
      }
    }
    return out;
  };

  /** Close `select`ed open asks across every built project (the `{task}` / `{pr}` expiry). */
  const expire = (stores: ProjectContext[], select: (ask: TaskAskRecord) => boolean, closed: QuestionClosed) => {
    for (const ctx of stores) {
      for (const run of ctx.store.listRuns()) {
        if (run.asks?.some((ask) => isOpenAsk(ask) && select(ask))) ctx.store.closeTaskAsks(run.id, select, closed);
      }
    }
  };

  /** A task reached a final state (or was deleted): asks declaring `{task}` about it expire. */
  const taskEnded = (projectId: string, runId: string, how: string) => {
    const task = `${projectId}/${runId}`;
    expire(builtContexts(), (ask) => isAboutTask(ask, task), { reason: 'expired', at: new Date(now()).toISOString(), detail: `Task ${how}` });
  };

  const attach = (ctx: ProjectContext) => {
    const store = ctx.store;
    if (attached.has(store)) return;
    attached.add(store);
    const onAsks = ({ runId, closed }: { runId: string; closed: TaskAskRecord[] }) => {
      const run = store.getRun(runId);
      if (run) remember(ctx.id, run);
      if (closed.length === 0 || !run) return fire({});
      for (const ask of closed) fire({ closedItem: item(ctx.id, run, ask) });
    };
    const remember = (projectId: string, run: RunRecord) => {
      const key = `${projectId}:${run.id}`;
      if (run.asks?.some(isOpenAsk)) lastOpen.set(key, { projectId, run: structuredClone(run) });
      else lastOpen.delete(key);
    };
    const onRun = (run: RunRecord) => {
      const key = `${ctx.id}:${run.id}`;
      const final = run.archived || ASK_ENDING_STATUSES.has(run.status);
      const before = wasFinal.get(key);
      wasFinal.set(key, final);
      if (final && before !== true) taskEnded(ctx.id, run.id, run.archived ? 'archived' : run.status === 'review' ? 'ready for review' : run.status);
    };
    const onDeleted = (runId: string) => {
      const key = `${ctx.id}:${runId}`;
      wasFinal.delete(key);
      const known = lastOpen.get(key);
      lastOpen.delete(key);
      const at = new Date(now()).toISOString();
      for (const ask of known?.run.asks?.filter(isOpenAsk) ?? []) {
        fire({ closedItem: item(ctx.id, known!.run, { ...ask, stale: undefined, closed: { reason: 'ended', at, detail: 'Task deleted' } }) });
      }
      taskEnded(ctx.id, runId, 'deleted');
    };
    for (const run of store.listRuns()) {
      remember(ctx.id, run);
      wasFinal.set(`${ctx.id}:${run.id}`, run.archived || ASK_ENDING_STATUSES.has(run.status));
    }
    store.on('asks', onAsks);
    store.on('run', onRun);
    store.on('deleted', onDeleted);
    cleanups.push(() => {
      store.off('asks', onAsks);
      store.off('run', onRun);
      store.off('deleted', onDeleted);
    });
    // A project opened after the inbox first read it from disk: the live store is the truth now.
    coldCache.delete(ctx.id);
  };

  for (const ctx of builtContexts()) attach(ctx);
  cleanups.push(contexts.onContextBuilt((ctx) => {
    attach(ctx);
    fire({});
  }));
  // Only a read that names its repo the way the run does closes a card: `verify` reads (an
  // automation poll that named the repo by remote) would need a GitHub call this provider never makes.
  cleanups.push(onPrClosed((root, number, state, verify) => {
    if (verify) return;
    const owners = builtContexts().filter((ctx) => ctx.root === root);
    expire(owners, (ask) => isAboutPr(ask, number), { reason: 'expired', at: new Date(now()).toISOString(), detail: `PR #${number} ${state}` });
  }));

  const projects = async () => {
    if (projectsCache && now() - projectsCache.at < PROJECTS_TTL_MS) return projectsCache.list;
    let list: ReadonlyArray<{ id: string; root: string }> = [];
    try {
      list = await listProjects();
    } catch {
      // an unreadable registry: built contexts still answer
    }
    projectsCache = { at: now(), list };
    return list;
  };

  const coldRuns = (projectId: string, root: string): RunRecord[] => {
    const dataDir = join(root, '.ai', 'cezar');
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(dataDir, 'runs.json')).mtimeMs;
    } catch {
      return [];
    }
    const cached = coldCache.get(projectId);
    if (cached?.mtimeMs === mtimeMs) return cached.runs;
    const runs = readRuns(dataDir).filter((run) => (run.asks?.length ?? 0) > 0);
    coldCache.set(projectId, { mtimeMs, runs });
    return runs;
  };

  /** The project's live context, built if needed: acting on a question is a reason to open it. */
  const contextFor = async (projectId: string): Promise<ProjectContext | QuestionResult> => {
    try {
      const ctx = await contexts.context(projectId);
      attach(ctx);
      return ctx;
    } catch (err) {
      // A gone root answers 409 like every project route; anything else is not found.
      if (err instanceof ProjectContextError && err.reason === 'missing-root') return { ok: false, status: 409, error: `project folder not found: ${projectId}` };
      return notFound;
    }
  };

  const resolve = async (key: string) => {
    const parsed = parseQuestionKey(key);
    if (parsed?.kind !== 'task') return notFound;
    const ctx = await contextFor(parsed.projectId);
    if ('ok' in ctx) return ctx;
    const run = ctx.store.getRun(parsed.runId);
    const ask = run?.asks?.find((candidate) => candidate.requestId === parsed.requestId);
    return run && ask ? { ctx, run, ask, runId: parsed.runId, requestId: parsed.requestId } : notFound;
  };

  const current = (ctx: ProjectContext, runId: string, requestId: string): QuestionResult => {
    const run = ctx.store.getRun(runId);
    const ask = run?.asks?.find((candidate) => candidate.requestId === requestId);
    return run && ask ? { ok: true, item: item(ctx.id, run, ask) } : { ok: false, status: 404, error: 'question not found' };
  };


  return {
    async list() {
      const built = builtContexts();
      const builtIds = new Set(built.map((ctx) => ctx.id));
      const out = built.flatMap((ctx) => itemsOf(ctx.id, ctx.store.listRuns()));
      for (const project of await projects()) {
        if (builtIds.has(project.id)) continue;
        out.push(...itemsOf(project.id, coldRuns(project.id, project.root)));
      }
      return out;
    },

    owns: (key) => parseQuestionKey(key)?.kind === 'task',

    async answer(key, text) {
      const found = await resolve(key);
      if ('ok' in found) return found;
      if (found.ask.closed) return alreadyClosed;
      const { ctx, runId, requestId } = found;
      const blocked = await deps.providerBlocked?.(ctx, found.run);
      if (blocked) return { ok: false, status: 409, error: blocked };
      const content = [{ type: 'text' as const, text }];
      // The composer's ladder (live session → between sessions), then the Continue an awaiting-answer run needs.
      const delivered = ctx.manager.sendMessage(runId, content, { askRequestId: requestId })
        || ctx.manager.deferMessage(runId, content, { askRequestId: requestId })
        || ctx.manager.continueRun(runId, { text, reply: { askRequestId: requestId } }).ok;
      if (!delivered) return { ok: false, status: 409, error: 'the task cannot take an answer now' };
      return current(ctx, runId, requestId);
    },

    async dismiss(key) {
      const found = await resolve(key);
      if ('ok' in found) return found;
      // A dismiss is a mutation and always closes; an unavailable provider only holds the note for the next Continue.
      const blocked = found.ask.closed ? undefined : await deps.providerBlocked?.(found.ctx, found.run);
      const outcome = found.ctx.manager.dismissAsk(found.runId, found.requestId, blocked ? { holdNote: true } : {});
      if (!outcome.ok) return outcome;
      return current(found.ctx, found.runId, found.requestId);
    },

    async close(key, closed) {
      const found = await resolve(key);
      if ('ok' in found) return found;
      if (!found.ask.closed) found.ctx.store.closeTaskAsks(found.runId, (ask) => ask.requestId === found.requestId, closed);
      return current(found.ctx, found.runId, found.requestId);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup();
      listeners.clear();
    },
  };
}
