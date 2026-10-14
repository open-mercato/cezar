import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession, ContentBlock } from '../core/agent-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { ResumeFallback, trackFallbackOutcome } from './resume-fallback.ts';
import { track } from '../telemetry.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

const MISSING: AgentEvent = { type: 'error', message: 'claude CLI exited with code 1 — No conversation found with session ID: s-1' };
const RESULT_ERROR: AgentEvent = { type: 'error', message: 'claude reported result error (error_during_execution)' };
const TURN_STARTED = { type: 'turn.started', turnId: 't1' } as unknown as UiEvent;
const ITEM = { type: 'item.started', item: { id: 'i1' } } as unknown as UiEvent;

function guard(resuming = true) {
  const out: string[] = [];
  const fallback = new ResumeFallback(
    resuming,
    (event) => out.push(`v1:${event.type}`),
    (event) => out.push(`v2:${event.type}`),
  );
  return { fallback, out };
}

function fakeSession(): AgentSession & { delivered: ContentBlock[][] } {
  const delivered: ContentBlock[][] = [];
  return {
    delivered,
    result: new Promise(() => {}),
    sendMessage: (content) => {
      delivered.push(content);
      return true;
    },
    end: () => {},
    interrupt: () => {},
    open: true,
  } as AgentSession & { delivered: ContentBlock[][] };
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

describe('ResumeFallback', () => {
  it('a missing conversation drops everything held and hands back what the user sent', () => {
    const { fallback, out } = guard();
    const session = fallback.track(fakeSession());
    expect(fallback.holdUi(TURN_STARTED)).toBe(true);
    session.sendMessage(text('also update the tests'));
    expect(fallback.hold(RESULT_ERROR)).toBe(true);
    // The dying attempt's own turn end is held with its error, not mistaken for life.
    expect(fallback.hold({ type: 'turn-end' })).toBe(true);
    expect(fallback.hold(MISSING)).toBe(true);
    expect(fallback.takeFallback()).toEqual([text('also update the tests')]);
    expect(out).toEqual([]);
    // Once only: the fresh session is never a resume.
    expect(fallback.hold(RESULT_ERROR)).toBe(false);
  });

  it('any other failure releases what was held, v2 first, and offers no fallback', () => {
    const { fallback, out } = guard();
    fallback.holdUi(TURN_STARTED);
    fallback.hold(RESULT_ERROR);
    fallback.hold({ type: 'turn-end' });
    expect(fallback.takeFallback()).toBeUndefined();
    expect(out).toEqual(['v2:turn.started', 'v1:error', 'v1:turn-end']);
  });

  it('a turn that ends cleanly proves the resume alive, so a later error shows at once', () => {
    const { fallback, out } = guard();
    fallback.holdUi(TURN_STARTED);
    expect(fallback.hold({ type: 'turn-end' })).toBe(false);
    expect(out).toEqual(['v2:turn.started']);
    expect(fallback.hold(RESULT_ERROR)).toBe(false);
  });

  it('any real v2 work proves the resume alive, and later sends are not replayed', () => {
    const { fallback } = guard();
    const session = fallback.track(fakeSession());
    expect(fallback.holdUi(ITEM)).toBe(false);
    session.sendMessage(text('next'));
    fallback.hold(MISSING);
    expect(fallback.takeFallback()).toBeUndefined();
  });

  it('a fresh (non-resumed) session passes everything straight through', () => {
    const { fallback } = guard(false);
    expect(fallback.holdUi(TURN_STARTED)).toBe(false);
    expect(fallback.hold(MISSING)).toBe(false);
  });
});

describe('trackFallbackOutcome — session_resume_fallback (#1438)', () => {
  beforeEach(() => vi.mocked(track).mockClear());
  const ended = (cancelled = false, sessionError?: string) => ({ cancelled: () => cancelled, sessionError: () => sessionError });

  it('recovered: the fresh session settled cleanly', async () => {
    await expect(trackFallbackOutcome(() => Promise.resolve('ok'), ended())).resolves.toBe('ok');
    expect(vi.mocked(track).mock.calls).toEqual([['session_resume_fallback', { label: 'recovered' }]]);
  });

  it('fresh_failed: the fresh session threw, or reported a session error — and no error text is sent', async () => {
    await expect(trackFallbackOutcome(() => Promise.reject(new Error('boom s-1')), ended())).rejects.toThrow('boom');
    await trackFallbackOutcome(() => Promise.resolve(undefined), ended(false, 'Invalid API key'));
    expect(vi.mocked(track).mock.calls).toEqual([
      ['session_resume_fallback', { label: 'fresh_failed' }],
      ['session_resume_fallback', { label: 'fresh_failed' }],
    ]);
  });

  it('fresh_failed when the fresh session cannot even launch', async () => {
    const launch = () => {
      throw new Error('spawn ENOENT');
    };
    await expect(trackFallbackOutcome(launch, ended())).rejects.toThrow('ENOENT');
    expect(vi.mocked(track).mock.calls).toEqual([['session_resume_fallback', { label: 'fresh_failed' }]]);
  });

  it('cancelled wins over how the session ended', async () => {
    await expect(trackFallbackOutcome(() => Promise.reject(new Error('killed')), ended(true))).rejects.toThrow();
    expect(vi.mocked(track).mock.calls).toEqual([['session_resume_fallback', { label: 'cancelled' }]]);
  });
});
