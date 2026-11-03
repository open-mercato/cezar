/**
 * The agent-step kill switch is an INACTIVITY bound, not a wall clock (cf2191f1): a step that
 * is still streaming frames is working, however long it takes, and only one that has gone
 * silent for `limitMs` is stuck. Every protocol frame a runner reads calls `touch()`.
 * A hard ceiling stays behind it, so a runaway step that never stops streaming is still bounded
 * — the guarantee the old wall clock carried (run.ts, the non-final step's `timeoutMs`).
 */
export interface InactivityDeadline {
  /** Record activity: restart the window. A no-op once expired or cleared. */
  touch(): void;
  clear(): void;
  /** Which bound fired, once one has. */
  readonly expiredBy: DeadlineExpiry | undefined;
}

export type DeadlineExpiry = 'inactivity' | 'ceiling';

/** The ceiling, as a multiple of the inactivity window: 30m silent, or 4h however busy. */
export const HARD_CEILING_FACTOR = 8;

/** `limitMs <= 0` disables both bounds (interactive sessions pass 0). */
export function armInactivityDeadline(
  limitMs: number,
  onExpire: () => void,
  ceilingMs: number = limitMs * HARD_CEILING_FACTOR,
): InactivityDeadline {
  if (!(limitMs > 0)) return { touch() {}, clear() {}, expiredBy: undefined };
  let expiredBy: DeadlineExpiry | undefined;
  const expire = (by: DeadlineExpiry): void => {
    if (expiredBy) return;
    expiredBy = by;
    clearTimeout(idle);
    clearTimeout(ceiling);
    onExpire();
  };
  const idle: NodeJS.Timeout = setTimeout(() => expire('inactivity'), limitMs);
  const ceiling: NodeJS.Timeout = setTimeout(() => expire('ceiling'), Math.max(ceilingMs, limitMs));
  idle.unref?.();
  ceiling.unref?.();
  let cleared = false;
  return {
    touch() {
      if (!cleared && !expiredBy) idle.refresh();
    },
    clear() {
      cleared = true;
      clearTimeout(idle);
      clearTimeout(ceiling);
    },
    get expiredBy() {
      return expiredBy;
    },
  };
}

function span(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 2 * 3_600_000) return `${Math.round((ms / 60_000) * 10) / 10}m`;
  return `${Math.round((ms / 3_600_000) * 10) / 10}h`;
}

/** One wording for every backend; `timed out after N(m|h)` keeps `failureKind` classifying it. */
export function inactivityTimeoutMessage(agent: string, limitMs: number, by: DeadlineExpiry = 'inactivity'): string {
  return by === 'ceiling'
    ? `${agent} timed out after ${span(limitMs * HARD_CEILING_FACTOR)} and was killed — Continue picks the task up again`
    : `${agent} timed out after ${span(limitMs)} without any output and was killed — Continue picks the task up again`;
}
