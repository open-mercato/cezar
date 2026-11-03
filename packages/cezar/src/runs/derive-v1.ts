import type { RunEvent } from '@open-mercato/cezar-contract';

/**
 * Reconstruct the v1 `tool-call` / `tool-result` lines of a transcript from
 * its persisted v2 tool items — the read-side half of "persist v2 only". The
 * RunManager fans those two v1 types out live and does not write them to the
 * NDJSON, so a consumer that wants the v1 vocabulary calls this.
 *
 *  - `tool-call` from the first sighting of a tool item, unless the tool was
 *    declined before it ran (no runner emits a v1 call for a denial);
 *  - `tool-result` from a `completed`/`failed` snapshot; a failed tool's
 *    result is its `error`, else its `output` (codex reports a failed
 *    command's stderr as output). A `declined` tool has no v1 result.
 *
 * The values are the v2 item's: `tool` is the item `name`, `input` and
 * `result` the normalized fields. Where a runner's live v1 line carries raw
 * wire JSON (codex, cursor, opencode), the derived line carries the
 * normalized v2 value instead.
 *
 * Idempotent over a legacy transcript: a v1 line already on disk is never
 * duplicated, so a file that predates persist-v2-only comes back unchanged.
 * The guard is per session window (`sessionWindows`), never file-global: item
 * ids repeat across sessions, and a run continued across the upgrade has v1
 * lines in its early sessions and none in its later ones.
 *
 * A derived event reuses the `seq` and `ts` of the v2 event it came from, so
 * the result is NOT seq-unique — never feed it into anything that dedups or
 * resumes by `seq` (SSE replay, `canonicalSessionItems`).
 */
export function deriveV1Events(events: readonly RunEvent[]): RunEvent[] {
  const windows = sessionWindows(events);
  const existingToolCalls = new Set<string>();
  const existingToolResults = new Set<string>();
  events.forEach((event, index) => {
    const window = windows[index]!;
    if (event.type === 'tool-call' && typeof event.id === 'string' && event.id !== '') {
      existingToolCalls.add(itemKey(window, event.id));
    } else if (event.type === 'tool-result' && typeof event.toolCallId === 'string') {
      existingToolResults.add(itemKey(window, event.toolCallId));
    }
  });

  const out: RunEvent[] = [];
  const seenTool = new Set<string>();
  events.forEach((event, index) => {
    out.push(event);
    const item = v2Item(event);
    if (!item || item.kind !== 'tool') return;
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined;
    if (id === undefined) return;
    const key = itemKey(windows[index]!, id);
    const stepId = typeof event.stepId === 'string' ? { stepId: event.stepId } : {};

    if (!seenTool.has(key)) {
      seenTool.add(key);
      if (item.status !== 'declined' && !existingToolCalls.has(key)) {
        out.push({
          type: 'tool-call',
          id,
          tool: typeof item.name === 'string' ? item.name : 'unknown',
          input: item.input,
          ...stepId,
          seq: event.seq,
          ts: event.ts,
        });
      }
    }
    if ((item.status === 'completed' || item.status === 'failed') && !existingToolResults.has(key)) {
      existingToolResults.add(key);
      const result = item.status === 'failed' ? (item.error ?? item.output) : item.output;
      out.push({
        type: 'tool-result',
        toolCallId: id,
        result: String(result ?? ''),
        isError: item.status === 'failed',
        ...stepId,
        seq: event.seq,
        ts: event.ts,
      });
    }
  });
  return out;
}

/**
 * One window id per event: its `stepId` plus the ordinal of the agent session
 * inside that step. Item ids are unique only within a session — a
 * continuation or a restart recovery mints `item_1` again. A
 * `session.started` opens a new window only once the current one has seen an
 * item, so v1 lines written before the session's own `session.started` stay in
 * the window of the items they twin.
 */
function sessionWindows(events: readonly RunEvent[]): string[] {
  const ordinal = new Map<string, number>();
  const hasItems = new Set<string>();
  return events.map((event) => {
    const step = typeof event.stepId === 'string' ? event.stepId : '';
    let current = ordinal.get(step) ?? 0;
    if (event.type === 'session.started' && hasItems.has(`${step}#${current}`)) {
      current += 1;
      ordinal.set(step, current);
    }
    const window = `${step}#${current}`;
    if (v2Item(event)) hasItems.add(window);
    return window;
  });
}

function itemKey(window: string, id: string): string {
  return `${window}:${id}`;
}

/** The item of a v2 item-lifecycle event, when it is an object (never an array). */
function v2Item(event: RunEvent): Record<string, unknown> | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') {
    return undefined;
  }
  const item = event.item as unknown;
  return typeof item === 'object' && item !== null && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : undefined;
}
