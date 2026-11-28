import {
  QUESTIONS_CLOSED_MAX,
  QUESTIONS_CLOSED_WINDOW_DAYS,
  QUESTIONS_OLDER_DEFAULT_DAYS,
  type QuestionClosed,
  type QuestionCounts,
  type QuestionItem,
  type QuestionsResponse,
} from '@open-mercato/cezar-contract';
import type { AnswerOptions, QuestionChange, QuestionProvider, QuestionResult } from './types.ts';

/**
 * The Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`): merges the manager and the
 * task providers, computes Older, folds a manager's relayed copy of a task question into the task's
 * item (counted once) and closes one copy when the other closes.
 */
export interface QuestionInboxDeps {
  task: QuestionProvider;
  /** Absent, or gated off by `managersEnabled`, under `CEZ_MANAGERS=0`: the inbox serves task questions only. */
  manager?: QuestionProvider;
  managersEnabled?: () => boolean;
  /** A deactivated manager's open cards stay listed but leave the counts (spec 2026-11-19-manager-deactivate). */
  managerInactive?: (managerId: string) => boolean;
  /** Workspace ui-state `questions.olderAfterDays`, read raw: anything but a non-negative integer is the default. */
  olderAfterDays?: () => Promise<unknown>;
  now?: () => number;
}

export interface QuestionInbox {
  list(): Promise<QuestionsResponse>;
  counts(): Promise<QuestionCounts>;
  answer(key: string, text: string, options?: AnswerOptions): Promise<QuestionResult>;
  dismiss(key: string): Promise<QuestionResult>;
  /** Fired after either provider changed (and on `refresh`), for the `questions` topic. */
  onChange(listener: () => void): () => void;
  /** Something the providers cannot see changed (the Older setting): tell listeners. */
  refresh(): void;
  /** Resolves once every in-flight linked-copy propagation settled (tests). */
  idle(): Promise<void>;
  dispose(): void;
}

const DAY_MS = 86_400_000;

/** `about: [{ task: "<p>/<r>", ask }]` refs of a manager item. */
function taskRefs(item: QuestionItem): Array<{ projectId: string; runId: string; ask: string }> {
  const refs: Array<{ projectId: string; runId: string; ask: string }> = [];
  for (const ref of item.about ?? []) {
    if (!('task' in ref) || !ref.ask) continue;
    const slash = ref.task.indexOf('/');
    if (slash <= 0 || slash === ref.task.length - 1) continue;
    refs.push({ projectId: ref.task.slice(0, slash), runId: ref.task.slice(slash + 1), ask: ref.ask });
  }
  return refs;
}

/** The request id at the end of an `r:<p>:<r>:<requestId>` key. */
function requestIdOf(item: QuestionItem): string | undefined {
  return item.key.startsWith('r:') ? item.key.split(':')[3] : undefined;
}

/** True when manager item `m` relays task item `t` (spec § answered elsewhere). */
function relays(m: QuestionItem, t: QuestionItem): boolean {
  if (m.source.kind !== 'manager' || t.source.kind !== 'task') return false;
  const { projectId, runId } = t.source;
  const requestId = requestIdOf(t);
  return taskRefs(m).some((ref) => ref.projectId === projectId && ref.runId === runId && (ref.ask === t.cardId || ref.ask === requestId));
}

export function resolveOlderAfterDays(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : QUESTIONS_OLDER_DEFAULT_DAYS;
}

export function createQuestionInbox(deps: QuestionInboxDeps): QuestionInbox {
  const now = deps.now ?? Date.now;
  const listeners = new Set<() => void>();
  const inFlight = new Set<Promise<void>>();
  const managerOn = (): QuestionProvider | undefined => (deps.manager && (deps.managersEnabled?.() ?? true) ? deps.manager : undefined);

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // one listener never stops the others
      }
    }
  };

  const providerList = async (provider: QuestionProvider | undefined): Promise<QuestionItem[]> =>
    provider ? provider.list().catch(() => []) : [];

  const olderDays = async (): Promise<number> => resolveOlderAfterDays(await deps.olderAfterDays?.().catch(() => undefined));

  /** Both lists, with each manager copy paired to the task item it relays (if that item is listed). */
  const load = async () => {
    const [tasks, managers] = await Promise.all([providerList(deps.task), providerList(managerOn())]);
    const pairOf = new Map<string, QuestionItem>(); // manager key → task item
    for (const m of managers) {
      if (m.source.kind !== 'manager') continue;
      const t = tasks.find((task) => relays(m, task));
      if (t) pairOf.set(m.key, t);
    }
    return { tasks, managers, pairOf };
  };

  const build = async (): Promise<QuestionsResponse> => {
    const [{ tasks, managers, pairOf }, olderAfterDays] = await Promise.all([load(), olderDays()]);
    const t0 = now();
    const olderCut = olderAfterDays > 0 ? t0 - olderAfterDays * DAY_MS : undefined;
    const closedCut = t0 - QUESTIONS_CLOSED_WINDOW_DAYS * DAY_MS;
    const out: QuestionItem[] = [];
    for (const t of tasks) {
      const copies = managers.filter((m) => pairOf.get(m.key) === t);
      // The chip shows a copy still asking alongside, or the copy closed together with it.
      const copy = copies.find((m) => !m.closed && !t.closed) ?? copies.find((m) => m.closed && t.closed);
      out.push({ ...t, ...(t.closed ? { closed: answeredInFromCopy(t.closed, copy) } : {}), ...(copy ? { linked: { key: copy.key, source: copy.source } } : {}) });
    }
    for (const m of managers) {
      const t = pairOf.get(m.key);
      // Folded into its task's item; shown on its own only while it asks a question the task already closed.
      if (t && !(t.closed && !m.closed)) continue;
      out.push(m);
    }
    const open: QuestionItem[] = [];
    const closed: QuestionItem[] = [];
    for (const item of out) {
      if (item.closed) {
        const at = Date.parse(item.closed.at);
        if (!Number.isNaN(at) && at >= closedCut) closed.push({ ...item, older: false });
        continue;
      }
      const asked = Date.parse(item.askedAt);
      open.push({ ...item, older: olderCut !== undefined && !Number.isNaN(asked) && asked < olderCut });
    }
    open.sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt));
    closed.sort((a, b) => Date.parse(b.closed!.at) - Date.parse(a.closed!.at));
    const counted = open.filter((item) => item.source.kind !== 'manager' || !deps.managerInactive?.(item.source.managerId));
    const live = counted.filter((item) => !item.older).length;
    return { open, closed: closed.slice(0, QUESTIONS_CLOSED_MAX), counts: { live, older: counted.length - live }, olderAfterDays };
  };

  /** The task copy answered on the manager card says where; derived at read time so it holds even if
   *  the task provider's `close` is a no-op on an already-answered item. */
  function answeredInFromCopy(closed: QuestionClosed, copy: QuestionItem | undefined): QuestionClosed {
    if (closed.reason !== 'answered' || closed.answeredIn || !copy?.closed || copy.source.kind !== 'manager') return closed;
    if (copy.closed.reason !== 'answered' || copy.closed.answeredIn) return closed;
    // Both answered on their own: the earlier answer is where it was given.
    if (Date.parse(copy.closed.at) > Date.parse(closed.at)) return closed;
    return { ...closed, answeredIn: `manager:${copy.source.managerId}` };
  }

  // One propagation per closed key at a time: the provider's onChange and the inbox's own mutation
  // both start one, and a manager answer must reach its task once.
  const running = new Map<string, Promise<void>>();
  const propagateOnce = (item: QuestionItem): Promise<void> => {
    const current = running.get(item.key);
    if (current) return current;
    const p = propagate(item).catch(() => {}).finally(() => {
      running.delete(item.key);
      inFlight.delete(p);
      notify();
    });
    running.set(item.key, p);
    inFlight.add(p);
    return p;
  };

  /** Close the other copy of a linked pair (spec § answered elsewhere). */
  const propagate = async (item: QuestionItem): Promise<void> => {
    const closed = item.closed;
    if (!closed) return;
    const manager = managerOn();
    if (!manager) return;
    if (item.source.kind === 'task') {
      // Closed BY its manager copy: that copy is already closed.
      if (closed.answeredIn) return;
      const { projectId, runId } = item.source;
      const copies = (await providerList(manager)).filter((m) => !m.closed && relays(m, item));
      const answeredIn = `task:${projectId}/${runId}`;
      for (const m of copies) {
        const next: QuestionClosed = closed.reason === 'answered'
          ? { reason: 'answered', at: new Date(now()).toISOString(), answeredIn, ...(closed.answer !== undefined ? { answer: closed.answer } : {}) }
          : { reason: closed.reason, at: new Date(now()).toISOString(), ...(closed.detail !== undefined ? { detail: closed.detail } : {}) };
        await manager.close(m.key, next).catch(() => undefined);
      }
      return;
    }
    // A manager copy: only an answer given on it travels to the task (other closes leave the task asking).
    if (item.source.kind !== 'manager' || closed.reason !== 'answered' || closed.answeredIn || closed.answer === undefined) return;
    const managerId = item.source.managerId;
    const targets = (await providerList(deps.task)).filter((t) => !t.closed && relays(item, t));
    for (const t of targets) {
      const result = await deps.task.answer(t.key, closed.answer).catch(() => undefined);
      if (!result?.ok) continue;
      await deps.task
        .close(t.key, { reason: 'answered', at: result.item.closed?.at ?? new Date(now()).toISOString(), answer: closed.answer, answeredIn: `manager:${managerId}` })
        .catch(() => undefined);
    }
  };

  const onProviderChange = (change: QuestionChange): void => {
    if (change.closedItem) void propagateOnce(change.closedItem);
    notify();
  };
  const offs = [deps.task.onChange(onProviderChange), ...(deps.manager ? [deps.manager.onChange(onProviderChange)] : [])];

  const providerFor = (key: string): QuestionProvider | undefined => {
    if (deps.task.owns(key)) return deps.task;
    const manager = managerOn();
    return manager?.owns(key) ? manager : undefined;
  };

  /** A manager key folded into an open task item answers (or dismisses) the task's copy instead. */
  const target = async (key: string): Promise<{ provider: QuestionProvider; key: string } | undefined> => {
    const provider = providerFor(key);
    if (!provider) return undefined;
    if (provider === deps.task) return { provider, key };
    const { managers, pairOf } = await load();
    const m = managers.find((item) => item.key === key);
    const t = m && pairOf.get(m.key);
    return t && !t.closed && !m.closed ? { provider: deps.task, key: t.key } : { provider, key };
  };

  const mutate = async (key: string, run: (provider: QuestionProvider, key: string) => Promise<QuestionResult>): Promise<QuestionResult> => {
    const resolved = await target(key);
    if (!resolved) return { ok: false, status: 404, error: 'question not found' };
    const result = await run(resolved.provider, resolved.key);
    if (!result.ok) return result;
    // Don't rely on the provider's onChange alone: the response shows the pair already closed.
    if (result.item.closed) await propagateOnce(result.item);
    const { open, closed } = await build();
    const item = [...open, ...closed].find((entry) => entry.key === result.item.key);
    return { ok: true, item: item ?? { ...result.item, older: false } };
  };

  return {
    list: build,
    counts: async () => (await build()).counts,
    answer: (key, text, options) => mutate(key, (provider, k) => provider.answer(k, text, options)),
    dismiss: (key) => mutate(key, (provider, k) => provider.dismiss(k)),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: notify,
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    dispose() {
      for (const off of offs) off();
      listeners.clear();
    },
  };
}
