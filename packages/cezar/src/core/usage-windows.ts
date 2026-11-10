import type { UsageWindow, UsageWindowsObservation } from '@open-mercato/cezar-contract';
import { parseUsageLimit } from './usage-limit.ts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const reset = (value: unknown): number | null => {
  const n = number(value);
  return n !== null && n > 0 && n <= 8_640_000_000_000 ? Math.floor(n * 1000) : null;
};
const status = (value: unknown): UsageWindow['status'] =>
  value === 'rejected' ? 'blocked' : value === 'allowed' || value === 'allowed_warning' ? 'allowed' : 'unknown';

/** Unknown/model-specific provider limit names are deliberately not guessed from a model string. */
function claudeWindow(id: string, raw: unknown, observedAt: number): UsageWindow {
  const w = record(raw);
  const utilization = number(w.utilization);
  return {
    id, kind: id === 'five_hour' ? 'five-hour' : id === 'seven_day' ? 'weekly' : 'other',
    applicability: id === 'five_hour' || id === 'seven_day' ? 'all' : 'unknown', models: [],
    resetsAt: reset(w.resetsAt),
    durationMinutes: id === 'five_hour' ? 300 : id === 'seven_day' ? 10080 : null,
    usedPercent: utilization === null ? null : number(utilization * 100),
    status: status(w.status), observedAt,
  };
}

export function normalizeClaudeUsageWindows(message: unknown, observedAt = Date.now()): UsageWindowsObservation | null {
  const msg = record(message);
  if (msg.type !== 'rate_limit_event') return null;
  const info = record(msg.rate_limit_info);
  const windows = new Map<string, UsageWindow>();
  for (const [id, raw] of Object.entries(record(info.unifiedWindows)).slice(0, 128)) {
    if (id.length > 0 && id.length <= 128) windows.set(id, claudeWindow(id, raw, observedAt));
  }
  // Global status belongs ONLY to the explicitly named limit, never every unified window.
  if (typeof info.rateLimitType === 'string' && info.rateLimitType.length > 0 && info.rateLimitType.length <= 128) {
    const id = info.rateLimitType;
    const previous = windows.get(id);
    const single = claudeWindow(id, info, observedAt);
    windows.set(id, previous ? {
      ...previous, resetsAt: single.resetsAt ?? previous.resetsAt,
      status: single.status, usedPercent: single.usedPercent ?? previous.usedPercent,
    } : single);
  }
  return { provider: 'claude', source: 'claude-stream', observedAt, windows: [...windows.values()].slice(0, 128) };
}

/** A refused Claude turn can carry an exact account reset without a rate_limit_event. */
export function normalizeClaudeTerminalUsageLimit(message: unknown, observedAt = Date.now()): UsageWindowsObservation | null {
  const msg = record(message);
  if (msg.type !== 'result' || msg.is_error !== true) return null;
  const texts = [msg.result, ...(Array.isArray(msg.errors) ? msg.errors.slice(0, 128) : [])];
  let resetsAt = observedAt;
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const hit = parseUsageLimit(text, observedAt);
    // Only canonical markers prove an account-wide block. Multiple terminal
    // errors still emit one observation, using the latest trusted future reset.
    if (hit?.evidence === 'claude-marker') resetsAt = Math.max(resetsAt, hit.resetAt.getTime());
  }
  if (resetsAt <= observedAt) return null;
  return { provider: 'claude', source: 'claude-stream', observedAt, windows: [{
    id: 'terminal-limit', kind: 'other', applicability: 'all', models: [],
    resetsAt, durationMinutes: null, usedPercent: 100,
    status: 'blocked', observedAt,
  }] };
}

export function normalizeCodexUsageWindows(
  payload: unknown, source: 'codex-notification' | 'codex-read' = 'codex-notification', observedAt = Date.now(),
): UsageWindowsObservation {
  const input = record(payload);
  const windows: UsageWindow[] = [];
  const byId = record(input.rateLimitsByLimitId);
  const add = (raw: unknown, mapId?: string) => {
    const limits = record(raw);
    const declaredId = typeof limits.limitId === 'string' ? limits.limitId : undefined;
    const id = mapId ?? declaredId;
    // Only the documented general Codex bucket is known to cover every model.
    // A legacy unkeyed snapshot is general only when no keyed buckets were supplied.
    const general = (id === 'codex' && (declaredId === undefined || declaredId === 'codex')) ||
      (id === undefined && Object.keys(byId).length === 0);
    if (!general && raw !== null && !Object.hasOwn(limits, 'primary') && !Object.hasOwn(limits, 'secondary')) {
      // Retain evidence of an unknown bucket even when its windows are absent. Dropping it
      // would let a previously cached general window hide unknown model applicability.
      windows.push({ id: `${id?.slice(0, 128) ?? 'unknown'}:unknown`, kind: 'other',
        applicability: 'unknown', models: [], resetsAt: null, durationMinutes: null,
        usedPercent: null, status: 'unknown', observedAt });
    }
    for (const kind of ['primary', 'secondary'] as const) {
      // null is explicit loss of knowledge; absent fields in an object are partial updates.
      if (raw !== null && !Object.hasOwn(limits, kind)) continue;
      const w = record(limits[kind]);
      const usedPercent = number(w.usedPercent);
      const duration = number(w.windowDurationMins);
      const limitId = id?.slice(0, 128);
      windows.push({
        id: `${limitId ?? 'codex'}:${kind}`, kind,
        ...(limitId === undefined ? {} : { limitId }),
        applicability: general ? 'all' : 'unknown', models: [],
        resetsAt: reset(w.resetsAt), durationMinutes: duration && duration > 0 ? duration : null,
        usedPercent, status: usedPercent === null ? 'unknown' : usedPercent >= 100 ? 'blocked' : 'allowed',
        observedAt,
      });
    }
  };
  // Keyed data is authoritative; the legacy rateLimits alias must not overwrite it.
  if (Object.keys(byId).length) {
    for (const [id, limits] of Object.entries(byId).slice(0, 64)) add(limits, id);
  } else if (Object.hasOwn(input, 'rateLimits')) add(input.rateLimits);
  return { provider: 'codex', source, observedAt, windows };
}

/** Metadata callbacks must never break a healthy agent stream, including async store failures. */
export function emitUsageWindows(
  callback: ((observation: UsageWindowsObservation) => void) | undefined,
  observation: UsageWindowsObservation | null,
): void {
  if (!callback || !observation) return;
  try { void Promise.resolve(callback(observation)).catch(() => {}); } catch { /* optional telemetry */ }
}
