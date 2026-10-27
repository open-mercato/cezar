import type { AgentBackend, AgentEvent, AgentSession, ContentBlock } from '../core/agent-runner.ts';
import { isClaudeMissingSessionError } from '../core/claude-cli-runner.ts';
import { isOpencodeMissingSessionError } from '../core/opencode-server-runner.ts';
import { isRuntimeProviderAuthFailure } from '../core/provider-auth.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { isUsageLimitMessage } from '../core/usage-limit.ts';
import { track } from '../telemetry.ts';

/**
 * The account or provider refused the turn, rather than the backend losing the session. A fresh
 * session would be refused the same way, after paying for the whole prompt again.
 */
export function isProviderRefusalError(message: string): boolean {
  return (
    isUsageLimitMessage(message) ||
    isRuntimeProviderAuthFailure(message) ||
    REFUSAL_PATTERNS.some((pattern) => pattern.test(message))
  );
}

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /overloaded|insufficient[_-]?quota|exceeded your current quota|credit\s+balance\s+(?:is\s+)?(?:too\s+low|exhausted)/i,
  /usage[_\s-]?limit[_\s-]?(?:reached|exceeded)|usageLimit(?:Reached|Exceeded)/i,
  /too many requests|\brate[\s_-]?limit(?:ed|_error)?\b/i,
  /payment required|\bbilling\b|\bforbidden\b|permission_error|not logged in|invalid api[\s-]?key/i,
  // A status code counts only where it reads as one: `HTTP 429`, `status: 403`, `429 Too Many`.
  /\b(?:http|status|code)\s*[:=]?\s*(?:402|403|429|529)\b|\b(?:402|403|429|529)\s+(?:too many|payment required|forbidden|overloaded|rate)/i,
];

/** A session killed at its wall clock: a fresh one would run into the same clock. */
export function isTimeoutError(message: string): boolean {
  return /\btimed out\b/i.test(message);
}

/** A held error that rules a retry's fallback out, whatever else the dying resume reported. */
export function vetoesRetryFallback(message: string): boolean {
  return isProviderRefusalError(message) || isTimeoutError(message);
}

/**
 * Which errors of a resume that never came alive mean "start over in a fresh session".
 *
 * A retry falls back on any such error that is not a refusal or a timeout (`vetoesRetryFallback`):
 * an allowlist of missing-session wordings would dead-end a backend whose wording cezar has never
 * seen, and a retry used to run fresh anyway. Continue reopens a session that may hold far more
 * than the saved context carries, so it falls back only on a recognised missing session — Claude's
 * pruned transcript, and opencode's gone session (opencode Continue always opened a fresh session
 * before it could resume).
 * A gone codex thread still fails a Continue.
 */
export function resumeFallbackPredicate(backend: AgentBackend, kind: 'retry' | 'continue'): (message: string) => boolean {
  if (kind === 'retry') return (message) => !vetoesRetryFallback(message);
  if (backend === 'opencode') return (message) => isClaudeMissingSessionError(message) || isOpencodeMissingSessionError(message);
  return isClaudeMissingSessionError;
}

/** v2 bookkeeping a dead resume still emits; any other v2 event is the session doing work. */
const HELD_UI_EVENTS = new Set<UiEvent['type']>([
  'session.started',
  'session.error',
  'turn.started',
  'turn.completed',
  'usage.updated',
]);

function isMessageText(event: UiEvent): boolean {
  if (event.type === 'item.delta') return event.field === 'text';
  return (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
    && event.item.kind === 'message';
}

/**
 * Guards one resumed session against a conversation the backend no longer has (Claude prunes
 * transcripts after `cleanupPeriodDays`; see `resumeFallbackPredicate` for the rest). Until the resume shows signs of life its errors and
 * turn bookkeeping are held back, and messages sent into it are remembered, so a fresh session
 * can take over without the failed attempt in the thread or the user's messages lost with it.
 * Shared by both resume sites — `runContinuation` and `runAgentStep` (AGENTS.md § construction sites).
 */
export class ResumeFallback {
  private pending: boolean;
  private missing = false;
  private vetoed = false;
  private heldError = false;
  /** `live` events were held only to keep a frame's order; they are released through `deliver`. */
  private held: { event: AgentEvent; live: boolean }[] = [];
  private heldUi: UiEvent[] = [];
  private sent: ContentBlock[][] = [];
  private frameOpen = false;

  constructor(
    resuming: boolean,
    /** Where a held error goes once it turns out to be a real failure. */
    private readonly emit: (event: AgentEvent) => void,
    /** Where a held v2 event goes once the session is proven alive or really failed. */
    private readonly emitUi: (event: UiEvent) => void,
    /** Which held errors mean the session is gone; Claude's pruned transcript unless told otherwise. */
    private readonly isMissing: (message: string) => boolean = isClaudeMissingSessionError,
    /** Held errors that rule the fallback out even when another one says the session is gone. */
    private readonly vetoes: (message: string) => boolean = () => false,
    /** The caller's live event path, for held text and the events that followed it. */
    private readonly deliver: (event: AgentEvent) => void = emit,
  ) {
    this.pending = resuming;
  }

  /** True when `event` was held back; the caller still treats a held error as the session's. */
  hold(event: AgentEvent): boolean {
    if (!this.pending) return false;
    if (event.type === 'error') {
      if (this.vetoes(event.message)) this.vetoed = true;
      else if (this.isMissing(event.message)) this.missing = true;
      this.heldError = true;
      this.held.push({ event, live: false });
      return true;
    }
    // Once an error is held, the dying attempt's turn bookkeeping goes with it.
    if (this.heldError && (event.type === 'turn-end' || event.type === 'note' || event.type === 'done')) {
      this.held.push({ event, live: false });
      return true;
    }
    if (event.type === 'text' && !this.heldError) {
      this.held.push({ event, live: true });
      this.settleAfterFrame();
      return true;
    }
    const alive =
      event.type === 'text' ||
      event.type === 'tool-call' ||
      event.type === 'tool-result' ||
      event.type === 'image' ||
      event.type === 'turn-end';
    if (alive) {
      this.settle();
      return false;
    }
    if (this.frameOpen) {
      this.held.push({ event, live: true });
      return true;
    }
    return false;
  }

  /** The v2 twin of `hold`: true when `event` was held back. */
  holdUi(event: UiEvent): boolean {
    if (!this.pending) return false;
    if (HELD_UI_EVENTS.has(event.type)) {
      this.heldUi.push(event);
      return true;
    }
    if (isMessageText(event) && !this.heldError) {
      this.heldUi.push(event);
      this.settleAfterFrame();
      return true;
    }
    this.settle();
    return false;
  }

  /**
   * Text proves the session alive only when no error follows in the same stdout line: Claude can
   * echo a missing-session reason into the `result` of the error frame, which arrives as text
   * just before the error. One line's events are delivered synchronously and the runners await
   * between lines, so a microtask runs after all of them. OpenCode's SSE reader dispatches every
   * frame of one network chunk in the same tick, so there a later frame's error can still count
   * against text that came before it.
   */
  private settleAfterFrame(): void {
    if (this.frameOpen) return;
    this.frameOpen = true;
    queueMicrotask(() => {
      this.frameOpen = false;
      if (this.pending && !this.heldError) this.settle();
    });
  }

  /** Remember what the user sends while the resume is unproven, to replay into a fresh session. */
  track(session: AgentSession): AgentSession {
    const send = session.sendMessage.bind(session);
    session.sendMessage = (content) => {
      const delivered = send(content);
      if (delivered && this.pending) this.sent.push(content);
      return delivered;
    };
    return session;
  }

  /**
   * The resumed session failed. When it failed because the conversation is gone, returns the
   * messages to replay into a fresh session and drops everything held; otherwise releases what
   * was held and returns undefined. Fires at most once — the fresh session is never a resume.
   */
  takeFallback(): ContentBlock[][] | undefined {
    if (!this.missing || this.vetoed) {
      this.release();
      return undefined;
    }
    const replay = this.sent;
    this.pending = false;
    this.missing = false;
    this.vetoed = false;
    this.heldError = false;
    this.held = [];
    this.heldUi = [];
    this.sent = [];
    return replay;
  }

  private settle(): void {
    this.sent = [];
    this.release();
  }

  private release(): void {
    const held = this.held;
    const heldUi = this.heldUi;
    this.pending = false;
    this.heldError = false;
    this.held = [];
    this.heldUi = [];
    for (const event of heldUi) this.emitUi(event);
    for (const { event, live } of held) (live ? this.deliver : this.emit)(event);
  }
}

/** A failing resume usually exits by itself, and its exit line is what says WHY — interrupting
 *  at once races that line (and a SIGTERM'd CLI exits "clean"). Stop it only if it lingers. */
const RESUME_ERROR_GRACE_MS = 2_000;

export function interruptAfterGrace(session: AgentSession | undefined): void {
  if (!session) return;
  setTimeout(() => session.interrupt(), RESUME_ERROR_GRACE_MS).unref?.();
}

/** No session id in the text: the store's secret redaction would print it as `[REDACTED]`. */
export const MISSING_SESSION_NOTE =
  "claude no longer has this conversation (its transcript was removed) — continuing in a fresh session with this task's saved context";

export function missingSessionNote(backend: AgentBackend): string {
  if (backend === 'claude') return MISSING_SESSION_NOTE;
  return `the ${backend} session could not be reopened — continuing in a fresh session with this task's saved context`;
}

/**
 * Awaits the fresh session that replaced a pruned resume and sends `session_resume_fallback` with
 * how it ended (#1438). Shared by both resume sites so their outcomes cannot drift.
 */
export async function trackFallbackOutcome<T>(
  /** Launches the fresh session and returns its result — inside, so a launch that throws still counts. */
  fresh: () => Promise<T>,
  ended: { cancelled: () => boolean; sessionError: () => string | undefined },
  backend?: AgentBackend,
): Promise<T> {
  let threw = false;
  try {
    return await fresh();
  } catch (err) {
    threw = true;
    throw err;
  } finally {
    const label = ended.cancelled() ? 'cancelled' : threw || ended.sessionError() !== undefined ? 'fresh_failed' : 'recovered';
    // Claude's label predates the other backends' fallback and stays bare.
    track('session_resume_fallback', { label: backend && backend !== 'claude' ? `${backend}:${label}` : label });
  }
}
