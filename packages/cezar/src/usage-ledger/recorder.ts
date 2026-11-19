import { randomUUID } from 'node:crypto';
import type { UsageWindowsObservation } from '@open-mercato/cezar-contract';
import { appendLedger, type LedgerConsumer } from './store.ts';

/** `claude:default`. The account half is the cezar agent-account id, never an email. */
export function ledgerAccountKey(provider: 'claude' | 'codex', accountId: string): string {
  return `${provider}:${accountId}`;
}

/** The account a reading or turn belongs to; `identity` fingerprints the login inside it. */
export interface LedgerAccountRef { key: string; label?: string; identity?: string }

const lastWritten = new Map<string, { usedPercent: number; status: string; at: number }>();
const REPEAT_MS = 10 * 60_000;

/**
 * Record the account-wide windows from one provider observation. Only limits known to cover
 * every model are kept (Claude's five_hour/seven_day, Codex's general bucket): a model-specific
 * bucket would be read as the whole account. Repeats of an unchanged reading are thinned.
 */
export function recordUsageObservation(ref: LedgerAccountRef, observation: UsageWindowsObservation): void {
  const { key: account, label, identity } = ref;
  for (const window of observation.windows) {
    if (window.usedPercent === null || window.resetsAt === null || window.applicability !== 'all') continue;
    let kind: 'five-hour' | 'weekly' | undefined;
    if (window.kind === 'five-hour' || window.kind === 'weekly') kind = window.kind;
    else if (window.kind === 'primary' || window.kind === 'secondary') {
      kind = window.durationMinutes === null
        ? (window.kind === 'primary' ? 'five-hour' : 'weekly')
        : window.durationMinutes <= 24 * 60 ? 'five-hour' : 'weekly';
    }
    if (!kind) continue;
    const key = `${account}|${identity ?? ''}|${kind}|${window.resetsAt}`;
    const previous = lastWritten.get(key);
    if (previous && previous.usedPercent === window.usedPercent && previous.status === window.status
      && window.observedAt - previous.at < REPEAT_MS) continue;
    if (lastWritten.size > 512) lastWritten.clear();
    lastWritten.set(key, { usedPercent: window.usedPercent, status: window.status, at: window.observedAt });
    appendLedger({
      t: 'reading', at: window.observedAt, account, ...(label ? { label: label.slice(0, 200) } : {}),
      ...(identity ? { identity } : {}),
      window: kind, usedPercent: Math.round(window.usedPercent * 100) / 100, resetsAt: window.resetsAt, status: window.status,
      source: observation.source,
    }, account);
  }
}

/**
 * One agent session's activity on one account: begin, a weighted sample per reported cost or
 * token count (covering the time since the previous one), end. A session that never ends (a
 * crash) stays open; the calculator bounds it and leaves its unweighted time unsplit.
 */
export class LedgerSession {
  readonly id = randomUUID();
  private cursor: number;
  private closed = false;
  private endedAt: number | undefined;

  readonly account: string;

  constructor(
    ref: LedgerAccountRef,
    readonly consumer: LedgerConsumer,
    options: { part?: 'chat' | 'watch' | 'job'; messageId?: string; now?: number } = {},
  ) {
    this.account = ref.key;
    this.cursor = options.now ?? Date.now();
    appendLedger({
      t: 'begin', at: this.cursor, account: ref.key, session: this.id,
      ...(ref.label ? { label: ref.label.slice(0, 200) } : {}),
      ...(ref.identity ? { identity: ref.identity } : {}),
      consumer: { ...consumer, title: consumer.title.slice(0, 300) },
      ...(options.part ? { part: options.part } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
    }, ref.key);
  }

  /** `late`: a cost reported just after the turn closed still belongs to that turn. */
  sample(weight: { usd?: number; tokens?: number }, now = Date.now(), late = false): void {
    if (this.closed && !late) return;
    const usd = weight.usd !== undefined && Number.isFinite(weight.usd) && weight.usd > 0 ? weight.usd : undefined;
    const tokens = weight.tokens !== undefined && Number.isFinite(weight.tokens) && weight.tokens > 0 ? weight.tokens : undefined;
    if (usd === undefined && tokens === undefined) return;
    // A late cost stays inside its turn, so it never weighs on time the session sat idle.
    const to = this.closed && this.endedAt !== undefined ? Math.max(this.cursor, this.endedAt) : Math.max(now, this.cursor);
    appendLedger({ t: 'sample', from: this.cursor, to, session: this.id, ...(usd !== undefined ? { usd } : {}), ...(tokens !== undefined ? { tokens } : {}) }, this.account);
    this.cursor = to;
  }

  end(options: { quiet?: boolean; now?: number } = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.endedAt = Math.max(options.now ?? Date.now(), this.cursor);
    appendLedger({ t: 'end', at: this.endedAt, session: this.id, ...(options.quiet !== undefined ? { quiet: options.quiet } : {}) }, this.account);
  }
}

/** A check step failed: every sample of this consumer since `since` was a failed attempt. */
export function recordFailedAttempt(account: string | undefined, consumerId: string, since: number, now = Date.now()): void {
  appendLedger({ t: 'attempt-failed', at: now, consumerId, since }, account);
}

/**
 * Turn-aware activity for one agent session: a ledger span per turn, so a session parked
 * between turns (waiting for the user) is never "running" while other work moves the limit.
 * Claude is weighted by reported cost, Codex by tokens — the units each reports per turn.
 */
export class PlanUsageTracker {
  private turn: LedgerSession | undefined;
  private last: LedgerSession | undefined;

  constructor(
    readonly provider: 'claude' | 'codex',
    readonly account: LedgerAccountRef,
    readonly consumer: LedgerConsumer,
    private readonly options: { part?: 'chat' | 'watch' | 'job'; messageId?: string; endOnClose?: boolean } = {},
  ) {}

  private open(): LedgerSession {
    if (!this.turn) {
      const { endOnClose: _endOnClose, ...session } = this.options;
      this.turn = new LedgerSession(this.account, this.consumer, session);
      this.last = this.turn;
    }
    return this.turn;
  }

  /** A v1 agent event. Only `cost` matters; it may land just after the turn closed. */
  event(event: { type: string; usd?: number }): void {
    if (event.type !== 'cost' || this.provider !== 'claude' || typeof event.usd !== 'number') return;
    (this.turn ?? this.last ?? this.open()).sample({ usd: event.usd }, Date.now(), true);
  }

  /** A v2 UI event: turn boundaries, and Codex's per-turn token usage. */
  ui(event: { type: string; usage?: { input?: unknown; output?: unknown } }): void {
    if (event.type === 'turn.started') this.open();
    else if (event.type === 'turn.completed') {
      if (this.provider === 'codex') {
        const input = typeof event.usage?.input === 'number' ? event.usage.input : 0;
        const output = typeof event.usage?.output === 'number' ? event.usage.output : 0;
        this.open().sample({ tokens: input + output });
      }
      // A one-turn session (a manager turn) ends on close, where its outcome is known.
      if (this.options.endOnClose) return;
      this.turn?.end();
      this.turn = undefined;
    }
  }

  /** The session settled: close a turn that never completed (a crash stays unweighted, hence unsplit). */
  close(options: { quiet?: boolean } = {}): void {
    this.turn?.end(options);
    this.turn = undefined;
  }
}

/** cezar's own one-shot model calls: tracked as their own consumer, so they never inflate a task. */
export const INTERNAL_CONSUMERS = {
  naming: { id: 'internal:auto-naming', kind: 'internal', title: 'Auto-naming (task titles, branches)' },
  commit: { id: 'internal:commit-messages', kind: 'internal', title: 'Commit messages' },
  planner: { id: 'internal:planner', kind: 'internal', title: 'Planner' },
} as const satisfies Record<string, LedgerConsumer>;

/**
 * Wrap a one-shot `runner.run`: one span from call to answer, weighted by the reported cost
 * (Claude) or tokens (Codex). Pass `onEvent` on to the runner. Off Claude/Codex it is a no-op.
 */
export function trackOneShot(provider: string, account: LedgerAccountRef | undefined, consumer: LedgerConsumer) {
  if (!account || (provider !== 'claude' && provider !== 'codex')) {
    return { onEvent: (_event: { type: string; usd?: number }) => {}, done: (_result?: { tokensUsed?: number }) => {} };
  }
  let session: LedgerSession | undefined;
  try { session = new LedgerSession(account, consumer); } catch { /* metadata only */ }
  let usd = 0;
  return {
    onEvent: (event: { type: string; usd?: number }) => { if (event.type === 'cost' && typeof event.usd === 'number') usd += event.usd; },
    done: (result?: { tokensUsed?: number }) => {
      if (!session) return;
      if (provider === 'claude') session.sample({ usd });
      else session.sample({ tokens: result?.tokensUsed ?? 0 });
      session.end();
    },
  };
}
