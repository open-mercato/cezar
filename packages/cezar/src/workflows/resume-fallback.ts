import type { AgentEvent, AgentSession, ContentBlock } from '../core/agent-runner.ts';
import { isClaudeMissingSessionError } from '../core/claude-cli-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { track } from '../telemetry.ts';

/** v2 bookkeeping a dead resume still emits; any other v2 event is the session doing work. */
const HELD_UI_EVENTS = new Set<UiEvent['type']>([
  'session.started',
  'session.error',
  'turn.started',
  'turn.completed',
  'usage.updated',
]);

/**
 * Guards one resumed session against a conversation the backend no longer has (Claude prunes
 * transcripts after `cleanupPeriodDays`). Until the resume shows signs of life its errors and
 * turn bookkeeping are held back, and messages sent into it are remembered, so a fresh session
 * can take over without the failed attempt in the thread or the user's messages lost with it.
 * Shared by both resume sites — `runContinuation` and `runAgentStep` (AGENTS.md § construction sites).
 */
export class ResumeFallback {
  private pending: boolean;
  private missing = false;
  private held: AgentEvent[] = [];
  private heldUi: UiEvent[] = [];
  private sent: ContentBlock[][] = [];

  constructor(
    resuming: boolean,
    /** Where a held error goes once it turns out to be a real failure. */
    private readonly emit: (event: AgentEvent) => void,
    /** Where a held v2 event goes once the session is proven alive or really failed. */
    private readonly emitUi: (event: UiEvent) => void,
  ) {
    this.pending = resuming;
  }

  /** True when `event` was held back; the caller still treats a held error as the session's. */
  hold(event: AgentEvent): boolean {
    if (!this.pending) return false;
    if (event.type === 'error') {
      if (isClaudeMissingSessionError(event.message)) this.missing = true;
      this.held.push(event);
      return true;
    }
    // Once an error is held, the dying attempt's turn bookkeeping goes with it.
    if (this.held.length > 0 && (event.type === 'turn-end' || event.type === 'note' || event.type === 'done')) {
      this.held.push(event);
      return true;
    }
    const alive =
      event.type === 'text' ||
      event.type === 'tool-call' ||
      event.type === 'tool-result' ||
      event.type === 'image' ||
      event.type === 'turn-end';
    if (alive) this.settle();
    return false;
  }

  /** The v2 twin of `hold`: true when `event` was held back. */
  holdUi(event: UiEvent): boolean {
    if (!this.pending) return false;
    if (HELD_UI_EVENTS.has(event.type)) {
      this.heldUi.push(event);
      return true;
    }
    this.settle();
    return false;
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
    if (!this.missing) {
      this.release();
      return undefined;
    }
    const replay = this.sent;
    this.pending = false;
    this.missing = false;
    this.held = [];
    this.heldUi = [];
    this.sent = [];
    return replay;
  }

  private settle(): void {
    this.pending = false;
    this.sent = [];
    this.release();
  }

  private release(): void {
    const held = this.held;
    const heldUi = this.heldUi;
    this.held = [];
    this.heldUi = [];
    for (const event of heldUi) this.emitUi(event);
    for (const event of held) this.emit(event);
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

/**
 * Awaits the fresh session that replaced a pruned resume and sends `session_resume_fallback` with
 * how it ended (#1438). Shared by both resume sites so their outcomes cannot drift.
 */
export async function trackFallbackOutcome<T>(
  /** Launches the fresh session and returns its result — inside, so a launch that throws still counts. */
  fresh: () => Promise<T>,
  ended: { cancelled: () => boolean; sessionError: () => string | undefined },
): Promise<T> {
  let threw = false;
  try {
    return await fresh();
  } catch (err) {
    threw = true;
    throw err;
  } finally {
    const label = ended.cancelled() ? 'cancelled' : threw || ended.sessionError() !== undefined ? 'fresh_failed' : 'recovered';
    track('session_resume_fallback', { label });
  }
}
