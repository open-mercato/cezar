import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';

import {
  RUN_HISTORY_PAGE_ITEMS,
  type RunEvent,
  type RunHistoryContext,
  type RunHistoryEvent,
  type RunHistoryPage,
} from '@open-mercato/cezar-contract';

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = 2_048;

const pageCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal('page'),
  direction: z.enum(['older', 'newer']),
  fileSize: z.number().int().nonnegative(),
  boundarySeq: z.number().int().nonnegative(),
});

const liveCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal('live'),
  offset: z.number().int().nonnegative(),
  boundarySeq: z.number().int().nonnegative(),
});

export class HistoryCursorError extends Error {
  readonly status: 400 | 409;

  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = 'HistoryCursorError';
    this.status = status;
  }
}

function encodeCursor(value: z.infer<typeof pageCursorSchema> | z.infer<typeof liveCursorSchema>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): unknown {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_BYTES) {
    throw new HistoryCursorError(400, 'invalid history cursor');
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new HistoryCursorError(400, 'invalid history cursor');
  }
}

export function decodePageCursor(cursor: string): z.infer<typeof pageCursorSchema> {
  const parsed = pageCursorSchema.safeParse(decodeCursor(cursor));
  if (!parsed.success) throw new HistoryCursorError(400, 'invalid history cursor');
  return parsed.data;
}

export function decodeLiveCursor(cursor: string): z.infer<typeof liveCursorSchema> {
  const parsed = liveCursorSchema.safeParse(decodeCursor(cursor));
  if (!parsed.success) throw new HistoryCursorError(400, 'invalid live cursor');
  return parsed.data;
}

function parseLine(line: string): RunHistoryEvent | null {
  try {
    const value = JSON.parse(line) as Partial<RunHistoryEvent>;
    return typeof value.seq === 'number' && typeof value.type === 'string' && typeof value.ts === 'string'
      ? (value as RunHistoryEvent)
      : null;
  } catch {
    return null;
  }
}

/**
 * Split a chunk read from right to left without decoding the unfinished record at its left edge.
 * NDJSON separators are single-byte ASCII, so complete records can be decoded safely after the
 * first LF while the raw prefix waits for the preceding byte chunk.
 */
function completeReverseLines(chunk: Buffer, suffix: Buffer): { prefix: Buffer; lines: string[] } {
  const combined = suffix.length === 0 ? chunk : Buffer.concat([chunk, suffix]);
  const firstNewline = combined.indexOf(0x0a);
  if (firstNewline === -1) return { prefix: Buffer.from(combined), lines: [] };
  return {
    prefix: Buffer.from(combined.subarray(0, firstNewline)),
    lines: combined.subarray(firstNewline + 1).toString('utf8').split('\n'),
  };
}

interface CanonicalItem {
  key: string;
  firstSeq: number;
  lastSeq: number;
}

const STANDALONE_TYPES = new Set([
  'user-message',
  'note',
  'lifecycle',
  'error',
  'session.error',
  'image',
  'check-output',
  'ask.requested',
  'provider-auth-required',
]);

function stringField(event: RunEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Classify the source events into the same protocol-level item units the cockpit renders.
 *
 * Projection always operates on complete collected turns. A v2-covered turn suppresses its v1
 * tool twins; lifecycle snapshots sharing a step/item identity collapse to one item.
 */
export function canonicalSessionItems(events: readonly RunEvent[]): CanonicalItem[] {
  const items = new Map<string, CanonicalItem>();
  let turn = 0;
  let turnHasV2 = false;
  const v1Tools: Array<{ key: string; call: RunEvent; result?: RunEvent }> = [];
  const v1Texts: RunEvent[] = [];
  const v2Texts: string[] = [];

  const upsert = (key: string, event: RunEvent) => {
    const existing = items.get(key);
    if (existing) {
      existing.firstSeq = Math.min(existing.firstSeq, event.seq);
      existing.lastSeq = Math.max(existing.lastSeq, event.seq);
    } else {
      items.set(key, { key, firstSeq: event.seq, lastSeq: event.seq });
    }
  };

  const flushTurn = () => {
    if (!turnHasV2) {
      for (const { key, call, result } of v1Tools) {
        upsert(key, call);
        if (result) upsert(key, result);
      }
      for (const event of v1Texts) upsert(`v1-text:${turn}:${event.seq}`, event);
    } else if (v2Texts.length > 0) {
      const normalize = (text: string) =>
        text
          .replace(/\s*CEZ:DONE\s*$/, '')
          .replace(/\s*CEZ:MONITORING\s*$/, '')
          .replace(/\s*CEZ:ASK[ \t]+\{[\s\S]*\}\s*$/, '')
          .split('\n')
          .filter((line) => !/^CEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/.test(line))
          .join('\n')
          .replace(/\s+/g, '');
      const v2Normalized = new Set(v2Texts.map(normalize));
      v2Normalized.add(normalize(v2Texts.join('')));
      for (let index = 0; index < v1Texts.length;) {
        const event = v1Texts[index]!;
        const text = stringField(event, 'text') ?? '';
        if (v2Normalized.has(normalize(text))) {
          index += 1;
          continue;
        }
        let matchedEnd = -1;
        let combined = text;
        for (let end = index + 1; end < v1Texts.length; end += 1) {
          combined += stringField(v1Texts[end]!, 'text') ?? '';
          if (v2Normalized.has(normalize(combined))) {
            matchedEnd = end;
            break;
          }
        }
        if (matchedEnd >= index + 1) {
          index = matchedEnd + 1;
          continue;
        }
        upsert(`v1-text:${turn}:${event.seq}`, event);
        index += 1;
      }
    } else {
      for (const event of v1Texts) upsert(`v1-text:${turn}:${event.seq}`, event);
    }
    v1Tools.length = 0;
    v1Texts.length = 0;
    v2Texts.length = 0;
    turnHasV2 = false;
  };

  for (const event of events) {
    if (event.type === 'user-message' || event.type === 'turn.started') {
      flushTurn();
      turn += 1;
    }
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const raw = event.item;
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const id = (raw as { id?: unknown }).id;
        if (typeof id === 'string' && id !== '') {
          turnHasV2 = true;
          upsert(`v2:${event.stepId ?? ''}:${id}`, event);
          const item = raw as { kind?: unknown; text?: unknown };
          if (item.kind === 'message' && typeof item.text === 'string') v2Texts.push(item.text);
        }
      }
      continue;
    }
    if (event.type === 'tool-call') {
      const id = stringField(event, 'id') ?? `seq:${event.seq}`;
      v1Tools.push({ key: `v1-tool:${turn}:${id}`, call: event });
      continue;
    }
    if (event.type === 'tool-result') {
      const id = stringField(event, 'toolCallId');
      const tool = id === undefined ? undefined : v1Tools.find(({ call }) => call.id === id);
      if (tool) tool.result = event;
      continue;
    }
    if (event.type === 'text') {
      v1Texts.push(event);
      continue;
    }
    if (event.type === 'step-end' && event.status === 'failed') {
      upsert(`standalone:${event.seq}`, event);
      continue;
    }
    if (STANDALONE_TYPES.has(event.type)) upsert(`standalone:${event.seq}`, event);
  }
  flushTurn();
  return [...items.values()].sort((a, b) => a.firstSeq - b.firstSeq);
}

async function reverseEventsUntil(
  filePath: string,
  beforeSeq: number,
  wantedItems: number,
): Promise<{
  events: RunHistoryEvent[];
  fileSize: number;
  fileHighWater: number;
  reachedStart: boolean;
  bytesRead: number;
}> {
  let fileSize = 0;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    return { events: [], fileSize: 0, fileHighWater: 0, reachedStart: true, bytesRead: 0 };
  }
  if (fileSize === 0) return { events: [], fileSize, fileHighWater: 0, reachedStart: true, bytesRead: 0 };

  const handle = await open(filePath, 'r');
  let position = fileSize;
  let suffix: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const reversed: RunHistoryEvent[] = [];
  let reachedStart = false;
  let totalBytesRead = 0;
  let fileHighWater = 0;
  try {
    while (position > 0) {
      const length = Math.min(READ_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      totalBytesRead += bytesRead;
      const split = completeReverseLines(buffer.subarray(0, bytesRead), suffix);
      suffix = split.prefix;
      const { lines } = split;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const event = parseLine(lines[index]!);
        if (event) {
          fileHighWater = Math.max(fileHighWater, event.seq);
          if (event.seq < beforeSeq) reversed.push(event);
        }
      }
      const chronological = [...reversed].reverse();
      if (
        canonicalSessionItems(chronological).length >= wantedItems + 1 &&
        chronological.some((event) => event.type === 'user-message' || event.type === 'turn.started')
      ) {
        break;
      }
    }
    if (position === 0) {
      reachedStart = true;
      const event = parseLine(suffix.toString('utf8'));
      if (event) {
        fileHighWater = Math.max(fileHighWater, event.seq);
        if (event.seq < beforeSeq) reversed.push(event);
      }
    }
  } finally {
    await handle.close();
  }
  return { events: reversed.reverse(), fileSize, fileHighWater, reachedStart, bytesRead: totalBytesRead };
}

async function readFileTail(filePath: string): Promise<{ fileSize: number; fileHighWater: number; bytesRead: number }> {
  let fileSize = 0;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    return { fileSize: 0, fileHighWater: 0, bytesRead: 0 };
  }
  if (fileSize === 0) return { fileSize, fileHighWater: 0, bytesRead: 0 };
  const handle = await open(filePath, 'r');
  let position = fileSize;
  let suffix: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let totalBytesRead = 0;
  try {
    while (position > 0) {
      const length = Math.min(READ_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      totalBytesRead += bytesRead;
      const split = completeReverseLines(buffer.subarray(0, bytesRead), suffix);
      suffix = split.prefix;
      const { lines } = split;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const event = parseLine(lines[index]!);
        if (event) return { fileSize, fileHighWater: event.seq, bytesRead: totalBytesRead };
      }
    }
    return {
      fileSize,
      fileHighWater: parseLine(suffix.toString('utf8'))?.seq ?? 0,
      bytesRead: totalBytesRead,
    };
  } finally {
    await handle.close();
  }
}

async function forwardEventsUntil(
  filePath: string,
  afterSeq: number,
  wantedItems: number,
): Promise<{ events: RunHistoryEvent[]; reachedEnd: boolean; bytesRead: number }> {
  const events: RunHistoryEvent[] = [];
  let previousBoundary: RunHistoryEvent | undefined;
  let reachedEnd = true;
  let input: ReturnType<typeof createReadStream> | undefined;
  try {
    input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;
      if (event.seq <= afterSeq) {
        if (event.type === 'user-message' || event.type === 'turn.started') previousBoundary = event;
        continue;
      }
      if (events.length === 0 && previousBoundary) events.push(previousBoundary);
      events.push(event);
      if (canonicalSessionItems(events).length >= wantedItems + 1) {
        reachedEnd = false;
        break;
      }
    }
  } catch {
    return { events: [], reachedEnd: true, bytesRead: 0 };
  } finally {
    input?.destroy();
  }
  return { events, reachedEnd, bytesRead: input?.bytesRead ?? 0 };
}

function pageEventSlice(events: RunHistoryEvent[], selected: CanonicalItem[]): RunHistoryEvent[] {
  const firstSeq = selected[0]?.firstSeq;
  if (firstSeq === undefined) return [];
  const start = events.findIndex((event) => event.seq >= firstSeq);
  if (start < 0) return [];
  let boundary: RunHistoryEvent | undefined;
  for (let index = start - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'user-message' || event.type === 'turn.started') {
      boundary = event;
      break;
    }
  }
  const pageEvents = events.slice(start);
  return boundary === undefined ? pageEvents : [boundary, ...pageEvents];
}

function forwardPageEventSlice(events: RunHistoryEvent[], selected: CanonicalItem[]): RunHistoryEvent[] {
  const lastSeq = selected.at(-1)?.lastSeq;
  if (lastSeq === undefined) return [];
  let end = events.length - 1;
  while (end >= 0 && events[end]!.seq > lastSeq) end -= 1;
  return events.slice(0, end + 1);
}

export interface HistoryReadInstrumentation {
  fileSize: number;
  bytesRead: number;
  retainedEvents: number;
}

export async function readRunHistoryPage(
  filePath: string,
  cursor?: string,
  onRead?: (instrumentation: HistoryReadInstrumentation) => void,
): Promise<RunHistoryPage> {
  const decoded = cursor === undefined ? undefined : decodePageCursor(cursor);
  const currentSize = await stat(filePath).then(({ size }) => size).catch(() => 0);
  if (decoded && decoded.fileSize > currentSize) {
    throw new HistoryCursorError(409, 'history cursor is no longer valid — reload the newest page');
  }
  const highWaterRead = await readFileTail(filePath);
  const forward = decoded?.direction === 'newer'
    ? await forwardEventsUntil(filePath, decoded.boundarySeq, RUN_HISTORY_PAGE_ITEMS)
    : undefined;
  const reverse = forward === undefined
    ? await reverseEventsUntil(
        filePath,
        decoded?.boundarySeq ?? Number.MAX_SAFE_INTEGER,
        RUN_HISTORY_PAGE_ITEMS,
      )
    : undefined;
  const scannedEvents = forward?.events ?? reverse?.events ?? [];
  const canonical = canonicalSessionItems(scannedEvents);
  const selected = forward
    ? canonical.slice(0, RUN_HISTORY_PAGE_ITEMS)
    : canonical.slice(-RUN_HISTORY_PAGE_ITEMS);
  const hasOlder = forward
    ? decoded!.boundarySeq > 0
    : canonical.length > selected.length || !(reverse?.reachedStart ?? true);
  const hasNewer = forward
    ? canonical.length > selected.length || !forward.reachedEnd
    : decoded !== undefined && selected.length > 0;
  const events = forward
    ? forwardPageEventSlice(scannedEvents, selected)
    : pageEventSlice(scannedEvents, selected);
  const asOfSeq = highWaterRead.fileHighWater;
  const oldest = selected[0];
  const newest = selected.at(-1);
  onRead?.({
    fileSize: highWaterRead.fileSize,
    bytesRead: (reverse?.bytesRead ?? forward?.bytesRead ?? 0) + highWaterRead.bytesRead,
    retainedEvents: scannedEvents.length,
  });
  return {
    events,
    itemCount: selected.length,
    ...(hasOlder && oldest
      ? {
          olderCursor: encodeCursor({
            v: 1,
            kind: 'page',
            direction: 'older',
            fileSize: highWaterRead.fileSize,
            boundarySeq: oldest.firstSeq,
          }),
        }
      : {}),
    ...(hasNewer && newest
      ? {
          newerCursor: encodeCursor({
            v: 1,
            kind: 'page',
            direction: 'newer',
            fileSize: highWaterRead.fileSize,
            boundarySeq: newest.lastSeq,
          }),
        }
      : {}),
    liveCursor: encodeCursor({ v: 1, kind: 'live', offset: highWaterRead.fileSize, boundarySeq: asOfSeq }),
    asOfSeq,
    hasOlder,
  };
}

interface ContextItem {
  id: string;
  parentId?: string;
  turn: number;
  first: RunHistoryEvent;
  latest: RunHistoryEvent;
  status?: string;
}

const isSettledContextStatus = (status: string | undefined) =>
  status !== undefined && status !== 'pending' && status !== 'running';

/** One forward pass retaining the latest Plan snapshot and only the selector-equivalent agent episode. */
export async function deriveRunContextEvents(filePath: string): Promise<RunHistoryContext> {
  let latestPlan: RunHistoryEvent | undefined;
  let asOfSeq = 0;
  let turn = 0;
  const boundaries: RunHistoryEvent[] = [];
  const roots = new Map<string, ContextItem>();
  const children = new Map<string, ContextItem>();
  const rootsByTurn = new Map<number, Set<string>>();

  const itemIdentity = (event: RunHistoryEvent, id: string) => `${event.stepId ?? ''}:${id}`;
  const pruneSettledHistory = () => {
    const rootTurns = [...rootsByTurn.keys()].sort((a, b) => a - b);
    const latestRootTurn = rootTurns.at(-1);
    if (latestRootTurn === undefined) return;
    let pruneThrough: number | undefined;
    for (let index = rootTurns.length - 2; index >= 0; index -= 1) {
      const candidate = rootTurns[index]!;
      const ids = rootsByTurn.get(candidate)!;
      if ([...ids].every((id) => isSettledContextStatus(roots.get(id)?.status))) {
        pruneThrough = candidate;
        break;
      }
    }
    const latestIds = rootsByTurn.get(latestRootTurn)!;
    if (
      turn > latestRootTurn &&
      [...latestIds].every((id) => isSettledContextStatus(roots.get(id)?.status))
    ) {
      pruneThrough = latestRootTurn;
    }
    if (pruneThrough === undefined) return;
    for (const [candidateTurn, ids] of rootsByTurn) {
      if (candidateTurn > pruneThrough) continue;
      for (const id of ids) roots.delete(id);
      rootsByTurn.delete(candidateTurn);
    }
    const retainedRootIds = new Set([...roots.values()].map(({ id }) => id));
    for (const [key, item] of children) {
      if (item.parentId === undefined || !retainedRootIds.has(item.parentId)) children.delete(key);
    }
    const earliest = Math.min(...[...roots.values()].map(({ first }) => first.seq), Number.MAX_SAFE_INTEGER);
    const firstRetained = boundaries.findIndex(({ seq }) => seq >= earliest);
    if (firstRetained === -1) boundaries.length = 0;
    else if (firstRetained > 0) boundaries.splice(0, firstRetained);
  };

  try {
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;
      asOfSeq = Math.max(asOfSeq, event.seq);
      if (event.type === 'plan.updated' || (event.type === 'tool-call' && stringField(event, 'tool') === 'TodoWrite')) {
        latestPlan = event;
        continue;
      }
      if (event.type === 'user-message' || event.type === 'turn.started') {
        turn += 1;
        boundaries.push(event);
        pruneSettledHistory();
        continue;
      }
      if (
        event.type === 'turn.completed' ||
        event.type === 'session.ended' ||
        event.type === 'session.error'
      ) {
        boundaries.push(event);
        continue;
      }
      if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
        const raw = event.item;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
        const item = raw as {
          id?: unknown;
          kind?: unknown;
          toolKind?: unknown;
          parentItemId?: unknown;
          status?: unknown;
        };
        if (item.kind !== 'tool' || typeof item.id !== 'string' || item.id === '') continue;
        const parentId = typeof item.parentItemId === 'string' ? item.parentItemId : undefined;
        const isRoot = item.toolKind === 'task' && parentId === undefined;
        if (!isRoot && parentId === undefined) continue;
        const key = itemIdentity(event, item.id);
        const collection = isRoot ? roots : children;
        const existing = collection.get(key);
        const next: ContextItem = existing
          ? { ...existing, latest: event, status: typeof item.status === 'string' ? item.status : existing.status }
          : {
              id: item.id,
              ...(parentId === undefined ? {} : { parentId }),
              turn,
              first: event,
              latest: event,
              ...(typeof item.status === 'string' ? { status: item.status } : {}),
            };
        collection.set(key, next);
        if (isRoot && !existing) {
          const ids = rootsByTurn.get(turn);
          if (ids) ids.add(key);
          else rootsByTurn.set(turn, new Set([key]));
        }
        pruneSettledHistory();
      }
    }
  } catch {
    return { contextEvents: [], asOfSeq: 0 };
  }
  pruneSettledHistory();
  const retainedRootIds = new Set([...roots.values()].map(({ id }) => id));
  const relevantChildren = [...children.values()].filter(
    ({ parentId }) => parentId !== undefined && retainedRootIds.has(parentId),
  );
  const contextEvents = new Map<number, RunHistoryEvent>();
  if (latestPlan) contextEvents.set(latestPlan.seq, latestPlan);
  for (const event of boundaries) contextEvents.set(event.seq, event);
  for (const item of [...roots.values(), ...relevantChildren]) {
    contextEvents.set(item.first.seq, item.first);
    contextEvents.set(item.latest.seq, item.latest);
  }
  return { contextEvents: [...contextEvents.values()].sort((a, b) => a.seq - b.seq), asOfSeq };
}

export async function readEventsAfterLiveCursor(filePath: string, cursor: string): Promise<{
  events: RunHistoryEvent[];
  boundarySeq: number;
}> {
  const decoded = decodeLiveCursor(cursor);
  let fileSize = 0;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    if (decoded.offset === 0) return { events: [], boundarySeq: decoded.boundarySeq };
    throw new HistoryCursorError(409, 'history cursor is no longer valid — reload the newest page');
  }
  if (decoded.offset > fileSize) {
    throw new HistoryCursorError(409, 'history cursor is no longer valid — reload the newest page');
  }
  if (decoded.offset === fileSize) return { events: [], boundarySeq: decoded.boundarySeq };
  const text = await new Promise<string>((resolve, reject) => {
    let value = '';
    const stream = createReadStream(filePath, { encoding: 'utf8', start: decoded.offset });
    stream.on('data', (chunk: string | Buffer) => {
      value += chunk.toString();
    });
    stream.on('end', () => resolve(value));
    stream.on('error', reject);
  });
  return {
    events: text.split('\n').map(parseLine).filter((event): event is RunHistoryEvent => event !== null),
    boundarySeq: decoded.boundarySeq,
  };
}

export async function validateLiveCursor(filePath: string, cursor: string): Promise<void> {
  const decoded = decodeLiveCursor(cursor);
  let fileSize = 0;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    if (decoded.offset === 0) return;
    throw new HistoryCursorError(409, 'history cursor is no longer valid — reload the newest page');
  }
  if (decoded.offset > fileSize) {
    throw new HistoryCursorError(409, 'history cursor is no longer valid — reload the newest page');
  }
}
