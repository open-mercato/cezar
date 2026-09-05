import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../runs/store.ts';
import {
  MAX_INITIAL_SSE_REPLAY_BYTES,
  MAX_SSE_EVENT_BYTES,
  prepareRunEventForSse,
  selectInitialSseReplay,
  sseReplayEventBytes,
} from './run-event-replay.ts';

const event = (seq: number, message: string): RunEvent => ({
  seq,
  ts: '2026-08-14T00:00:00.000Z',
  type: 'note',
  message,
});

describe('bounded per-run SSE replay', () => {
  it('keeps only a byte-bounded contiguous tail for a cursorless initial connection', () => {
    const events = Array.from({ length: 40 }, (_, index) => event(index + 1, 'x'.repeat(100_000)));

    const replay = selectInitialSseReplay(events);

    expect(replay.length).toBeLessThan(events.length);
    expect(replay.at(-1)?.seq).toBe(events.at(-1)?.seq);
    expect(replay.map(({ seq }) => seq)).toEqual(
      Array.from({ length: replay.length }, (_, index) => events.length - replay.length + index + 1),
    );
    expect(replay.reduce((bytes, item) => bytes + sseReplayEventBytes(item), 0))
      .toBeLessThanOrEqual(MAX_INITIAL_SSE_REPLAY_BYTES);
  });

  it('preserves the event envelope but bounds a single oversized payload', () => {
    const original = event(7, 'x'.repeat(MAX_SSE_EVENT_BYTES * 5));

    const prepared = prepareRunEventForSse(original);

    expect(prepared).toMatchObject({ seq: 7, ts: original.ts, type: 'note' });
    expect(prepared).not.toBe(original);
    expect(JSON.stringify(prepared)).toContain('truncated for SSE');
    expect(sseReplayEventBytes(prepared)).toBeLessThanOrEqual(MAX_SSE_EVENT_BYTES);
    expect(original.message).toHaveLength(MAX_SSE_EVENT_BYTES * 5);
  });
});
