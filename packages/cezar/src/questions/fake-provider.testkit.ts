import type { QuestionAbout, QuestionClosed, QuestionItem } from '@open-mercato/cezar-contract';
import type { QuestionChange, QuestionProvider, QuestionResult } from './types.ts';

/** An in-memory `QuestionProvider` for the inbox's tests: records every call, fires onChange like a real one. */
export interface FakeProvider extends QuestionProvider {
  items: Map<string, QuestionItem>;
  calls: Array<{ op: 'answer' | 'dismiss' | 'close'; key: string; text?: string; closed?: QuestionClosed }>;
  /** Close from inside the source (the agent replaced it, the task ended…), firing onChange. */
  closeFromSource(key: string, closed: Omit<QuestionClosed, 'at'> & { at?: string }): void;
  /** Make the next `list()` throw. */
  failList?: boolean;
}

export function fakeProvider(prefix: 'm' | 'r', seed: QuestionItem[] = []): FakeProvider {
  const items = new Map(seed.map((item) => [item.key, item]));
  const listeners = new Set<(change: QuestionChange) => void>();
  const calls: FakeProvider['calls'] = [];
  const fire = (closedItem?: QuestionItem) => { for (const l of [...listeners]) l(closedItem ? { closedItem } : {}); };
  const closeWith = (key: string, closed: QuestionClosed): QuestionResult => {
    const item = items.get(key);
    if (!item) return { ok: false, status: 404, error: 'question not found' };
    if (item.closed) return { ok: false, status: 409, error: 'question already closed' };
    const next = { ...item, closed };
    items.set(key, next);
    fire(next);
    return { ok: true, item: next };
  };
  const provider: FakeProvider = {
    items,
    calls,
    async list() {
      if (provider.failList) throw new Error('list failed');
      return [...items.values()];
    },
    owns: (key) => key.startsWith(`${prefix}:`),
    async answer(key, text) {
      calls.push({ op: 'answer', key, text });
      return closeWith(key, { reason: 'answered', at: new Date().toISOString(), answer: text });
    },
    async dismiss(key) {
      calls.push({ op: 'dismiss', key });
      return closeWith(key, { reason: 'dismissed', at: new Date().toISOString() });
    },
    async close(key, closed) {
      calls.push({ op: 'close', key, closed });
      const item = items.get(key);
      if (!item) return { ok: false, status: 404, error: 'question not found' };
      if (item.closed) return { ok: true, item };
      const next = { ...item, closed };
      items.set(key, next);
      fire(next);
      return { ok: true, item: next };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closeFromSource(key, closed) {
      closeWith(key, { at: new Date().toISOString(), ...closed });
    },
  };
  return provider;
}

const iso = (msAgo: number, now = Date.now()) => new Date(now - msAgo).toISOString();
const question = (header: string) => ({ header, question: `${header}?`, options: [{ label: 'Yes' }, { label: 'No' }] });

export function taskItem(projectId: string, runId: string, requestId: string, opts: { cardId?: string; askedMsAgo?: number; closed?: QuestionClosed } = {}): QuestionItem {
  return {
    key: `r:${projectId}:${runId}:${requestId}`,
    source: { kind: 'task', projectId, runId, title: `Task ${runId}`, status: 'waiting' },
    ...(opts.cardId ? { cardId: opts.cardId } : {}),
    askedAt: iso(opts.askedMsAgo ?? 60_000),
    questions: [question('Scope')],
    older: false,
    ...(opts.closed ? { closed: opts.closed } : {}),
  };
}

export function managerItem(managerId: string, messageId: string, opts: { about?: QuestionAbout; askedMsAgo?: number; closed?: QuestionClosed } = {}): QuestionItem {
  return {
    key: `m:${managerId}:${messageId}`,
    source: { kind: 'manager', managerId, name: `Manager ${managerId}` },
    askedAt: iso(opts.askedMsAgo ?? 30_000),
    questions: [question('Design')],
    ...(opts.about ? { about: opts.about } : {}),
    older: false,
    ...(opts.closed ? { closed: opts.closed } : {}),
  };
}
