import type { RunEvent } from '../runs/store.ts';

/** Maximum wire footprint of the initial cursorless replay, including SSE framing estimates. */
export const MAX_INITIAL_SSE_REPLAY_BYTES = 1_500_000;
/** Maximum wire footprint of one run-event frame. Full payloads remain available through history. */
export const MAX_SSE_EVENT_BYTES = 256 * 1024;

const MAX_SSE_STRING_CHARS = 64 * 1024;
const SSE_FRAME_OVERHEAD_BYTES = 128;
const TRUNCATION_MARKER = '\n… [truncated for SSE; full payload available from run history]';

/** Conservative byte estimate for the id/event/data framing written around one event. */
export function sseReplayEventBytes(event: RunEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8') + SSE_FRAME_OVERHEAD_BYTES;
}

function truncateLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= MAX_SSE_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_SSE_STRING_CHARS)}${TRUNCATION_MARKER}`;
  }
  if (Array.isArray(value)) return value.map(truncateLongStrings);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, truncateLongStrings(nested)]),
  );
}

/**
 * Keep ordinary event payloads byte-identical while preventing one persisted tool result from
 * monopolising (and repeatedly killing) a browser's EventSource connection. The append-only NDJSON
 * file and paged history responses remain untouched; only the live SSE projection is bounded.
 */
export function prepareRunEventForSse(event: RunEvent): RunEvent {
  const originalBytes = sseReplayEventBytes(event);
  if (originalBytes <= MAX_SSE_EVENT_BYTES) return event;

  const truncated = truncateLongStrings(event) as RunEvent;
  if (sseReplayEventBytes(truncated) <= MAX_SSE_EVENT_BYTES) return truncated;

  return {
    seq: event.seq,
    ts: event.ts,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    type: event.type,
    ssePayloadOmitted: true,
    originalBytes,
    message: `Event payload omitted from SSE (${originalBytes} bytes; limit ${MAX_SSE_EVENT_BYTES}). Full payload is available from run history.`,
  };
}

/**
 * Project and retain the newest contiguous events that fit the initial replay budget. A client
 * that needs older events uses the paged history route; reconnects resume from the emitted ids.
 */
export function selectInitialSseReplay(events: readonly RunEvent[]): RunEvent[] {
  const selected: RunEvent[] = [];
  let selectedBytes = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = prepareRunEventForSse(events[index]!);
    const eventBytes = sseReplayEventBytes(event);
    if (selectedBytes + eventBytes > MAX_INITIAL_SSE_REPLAY_BYTES) break;
    selected.unshift(event);
    selectedBytes += eventBytes;
  }
  return selected;
}
