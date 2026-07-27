/**
 * Protocol-v2 persistence + fan-out policy for one agent session — the
 * RunManager feeds every `UiEvent` a runner emits (`SessionOptions.onUiEvent`)
 * through one sink instance and the sink decides, per the spec's performance
 * guardrails (§"Normalized agent-event protocol v2" and
 * `.ai/analysis/cockpit-ui-redesign/protocol-rationale-and-performance.md` §5):
 *
 *  - `item.delta` is COALESCED per item (~40 ms flush) onto the live wire
 *    only — raw deltas NEVER hit the NDJSON file; replay needs no delta
 *    reduction because every item's final state rides `item.completed`.
 *  - Everything else persists as snapshots via `persist()` (the store stamps
 *    `seq`/`ts`, and `appendEvent` already fans persisted lines out live, so
 *    a persisted event is never double-emitted here).
 *  - `item.updated` hits disk only on a meaningful change (status flip, new
 *    diffs/title/…) — streamed-content-only growth goes to the live wire
 *    ephemerally, mirroring what the deltas already carry.
 *  - `usage.updated` is cumulative per session: persisted only when the
 *    total (or cost) actually moved, mirroring v1's token-usage cadence.
 *
 * Output errors are swallowed: v2 is additive and best-effort — a persist
 * failure (e.g. the run was deleted mid-flush) must never disturb the v1
 * stream or crash a timer callback.
 */

import type { StopReason, UiEvent, UiItem, UiItemDeltaEvent } from '../core/ui-events.js';

/** Spec guardrail: coalesce `item.delta` at ~30–50 ms boundaries. */
export const DELTA_FLUSH_MS = 40;
/** Backstop so one item can never buffer unboundedly within a window. */
const MAX_DELTA_BUFFER = 64_000;

/**
 * v2 lines share the NDJSON file and the store's event bus with v1, but ride
 * a DIFFERENT SSE event name (`ui-event` vs `run-event`) so the legacy UI —
 * which knew only `run-event` and JSON-dumped unknown types into the
 * transcript; retired in R7, but the name split stays as wire shape — never
 * saw them. The discriminator is the dotted namespace:
 * every v2 type on the wire is dotted (`item.started`, `turn.completed`, …)
 * and no v1 type is. v2's only undotted type, `image`, never reaches the
 * store: the sink drops it in favor of the v1 image pipeline (which persists
 * the file and re-emits a URL instead of raw base64).
 */
export function isV2WireEventType(type: string): boolean {
  return type.includes('.');
}

/** A loose event as the store consumes it (the sink adds no seq/ts — the
 *  store stamps those). */
type WireEvent = { type: string; [key: string]: unknown };

export interface UiEventSinkOutput {
  /** Append to the run's NDJSON file (which also fans out live). */
  persist(event: WireEvent): void;
  /** Fan out live only — never written to disk (coalesced deltas). */
  emitLive(event: WireEvent): void;
}

export class UiEventSink {
  /** Pending delta text per open item, per streamed field (insertion order
   *  preserved so a flush replays fields in first-arrival order). */
  private readonly buffers = new Map<string, Map<UiItemDeltaEvent['field'], string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Last persisted non-streamed shape per item — the `item.updated`
   *  meaningful-change filter. */
  private readonly shapes = new Map<string, string>();
  private lastUsage: { total: number; costUsd: number | undefined } | null = null;
  private ended = false;

  constructor(
    private readonly out: UiEventSinkOutput,
    private readonly flushMs: number = DELTA_FLUSH_MS,
  ) {}

  /** Fold one runner-emitted v2 event into the persist/live outputs. */
  handle(event: UiEvent): void {
    if (this.ended) return;
    switch (event.type) {
      case 'item.delta':
        this.bufferDelta(event);
        return;
      case 'item.started':
        this.shapes.set(event.item.id, itemShape(event.item));
        this.persist(event);
        return;
      case 'item.updated': {
        // Chronology: the item's buffered deltas reach the live wire before
        // the snapshot that supersedes them.
        this.flushItem(event.item.id);
        const shape = itemShape(event.item);
        if (this.shapes.get(event.item.id) === shape) {
          // Streamed-content-only growth — live consumers still get the
          // snapshot, the disk stays at snapshot-change frequency.
          this.emitLive(event);
          return;
        }
        this.shapes.set(event.item.id, shape);
        this.persist(event);
        return;
      }
      case 'item.completed':
        this.flushItem(event.item.id);
        this.shapes.delete(event.item.id);
        this.persist(event);
        return;
      case 'turn.completed':
        this.flushAll();
        this.persist(event);
        return;
      case 'usage.updated': {
        if (
          this.lastUsage !== null &&
          this.lastUsage.total === event.usage.total &&
          this.lastUsage.costUsd === event.costUsd
        ) {
          return;
        }
        this.lastUsage = { total: event.usage.total, costUsd: event.costUsd };
        this.persist(event);
        return;
      }
      case 'image':
        // The v1 image pipeline already persists the screenshot as a file
        // and re-emits a URL — persisting this raw-base64 twin would write
        // the payload to the NDJSON file. Dropped until R3 links images to
        // items by `itemId`.
        return;
      default:
        // session.*, turn.started, plan.updated, permission.* — plain
        // snapshot/lifecycle lines, persisted as they come. (`session.ended`
        // and fatal `session.error` are normally minted by `sessionEnded()`;
        // mapper-emitted ones — e.g. opencode's non-fatal session.error —
        // pass through here.)
        this.persist(event);
        return;
    }
  }

  /**
   * Session close, called by the RunManager exactly once when the v1 session
   * settles: flush everything, then persist v2 `session.error` (fatal) when
   * the session failed, and `session.ended` — the v2 counterparts of v1's
   * `done`/`error`, which the mappers deliberately left to the RunManager.
   */
  sessionEnded(reason: StopReason, errorMessage?: string): void {
    if (this.ended) return;
    this.flushAll();
    if (errorMessage !== undefined) {
      this.persist({ type: 'session.error', message: errorMessage, fatal: true });
      this.persist({ type: 'session.ended', reason, message: errorMessage });
    } else {
      this.persist({ type: 'session.ended', reason });
    }
    this.ended = true;
  }

  /** Flush every open coalescer now (turn end, session settle). */
  flushAll(): void {
    for (const itemId of [...this.buffers.keys()]) this.flushItem(itemId);
  }

  // ---- internals -----------------------------------------------------------

  private bufferDelta(event: UiItemDeltaEvent): void {
    let fields = this.buffers.get(event.itemId);
    if (!fields) {
      fields = new Map();
      this.buffers.set(event.itemId, fields);
    }
    const pending = (fields.get(event.field) ?? '') + event.delta;
    fields.set(event.field, pending);
    if (pending.length >= MAX_DELTA_BUFFER) {
      this.flushItem(event.itemId);
      return;
    }
    if (!this.timers.has(event.itemId)) {
      const timer = setTimeout(() => this.flushItem(event.itemId), this.flushMs);
      timer.unref?.();
      this.timers.set(event.itemId, timer);
    }
  }

  /** Emit one merged `item.delta` per buffered field of the item, live only. */
  private flushItem(itemId: string): void {
    const timer = this.timers.get(itemId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(itemId);
    }
    const fields = this.buffers.get(itemId);
    if (!fields) return;
    this.buffers.delete(itemId);
    for (const [field, delta] of fields) {
      if (delta !== '') this.emitLive({ type: 'item.delta', itemId, field, delta });
    }
  }

  // UiEvent members carry no index signature; they are plain JSON objects at
  // runtime, so widening them to the store's loose event shape is safe.
  private persist(event: UiEvent | WireEvent): void {
    try {
      this.out.persist(event as WireEvent);
    } catch {
      // best effort — v2 must never disturb the v1 stream
    }
  }

  private emitLive(event: UiEvent | WireEvent): void {
    try {
      this.out.emitLive(event as WireEvent);
    } catch {
      // best effort
    }
  }
}

/** The item minus its delta-streamed content field — what "meaningful
 *  snapshot change" compares. Mappers build items with stable key order, so
 *  JSON equality is a faithful (and cheap) identity; a false negative merely
 *  persists one extra snapshot. */
function itemShape(item: UiItem): string {
  if (item.kind === 'tool') {
    const { output: _output, ...rest } = item;
    return JSON.stringify(rest);
  }
  const { text: _text, ...rest } = item;
  return JSON.stringify(rest);
}
