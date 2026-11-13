import { setImmediate as nextTurn } from 'node:timers/promises';
import { vi } from 'vitest';

// Shared fake-clock helpers for the chat suites: time moves only when a test says so, while
// real I/O (files, loopback sockets, undici mocks) keeps running on the real event loop.

let restoreTimeout: (() => void) | undefined;

/**
 * From here on timers, Date and `AbortSignal.timeout` (Node's own timer, invisible to
 * vi.useFakeTimers) advance only through {@link ticks}, {@link elapse}, {@link eventually} and {@link drive}.
 */
export function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
  restoreTimeout = () => spy.mockRestore();
}
/** Undoes {@link fakeClock}; safe to call when the clock is already real. */
export function realClock(): void {
  vi.useRealTimers(); restoreTimeout?.(); restoreTimeout = undefined;
}

/**
 * Lets real I/O catch up before fake time moves again: a few real event-loop turns, and no
 * file-system request left in flight. Without it a fake timeout could fire "before" a write
 * that, in real time, would long have finished.
 */
export async function quiesce(): Promise<void> {
  for (let idle = 0; idle < 3;) {
    await nextTurn();
    idle = process.getActiveResourcesInfo().some(resource => resource.startsWith('FSReq')) ? 0 : idle + 1;
  }
}
/** Advances fake time by `ms` in `step` slices, letting real I/O settle before each slice. */
export async function elapse(ms: number, step = 10): Promise<void> {
  for (let done = 0; done < ms; done += step) { await quiesce(); await vi.advanceTimersByTimeAsync(Math.min(step, ms - done)); }
  await quiesce();
}
/** Runs `count` 1 s maintenance ticks: any resend the runtime would make has been sent when this resolves. */
export const ticks = (count: number) => elapse(count * 1000, 100);
/** vi.waitFor / expect.poll on the fake clock: retries every `step` fake ms for at most `seconds` fake seconds. */
export async function eventually(assertion: () => unknown, seconds = 30, step = 10): Promise<void> {
  for (let elapsed = 0; ; elapsed += step) {
    try { await assertion(); return; } catch (error) { if (elapsed >= seconds * 1000) throw error; }
    await quiesce(); await vi.advanceTimersByTimeAsync(step);
  }
}
/** Awaits `promise` while fake time advances; rejects when it is still pending after `ms` fake ms. */
export async function drive<T>(promise: Promise<T>, ms = 60_000, step = 10): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; ; elapsed += step) {
    await quiesce();
    if (settled) return promise;
    if (elapsed >= ms) throw new Error(`still pending after ${ms} fake ms`);
    await vi.advanceTimersByTimeAsync(step);
  }
}
/** expect.poll that also works on the fake clock. */
export const until = (assertion: () => unknown) => vi.isFakeTimers() ? eventually(assertion) : vi.waitFor(assertion as () => void);
