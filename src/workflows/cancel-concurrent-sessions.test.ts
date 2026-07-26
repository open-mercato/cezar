import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The safety property behind parallel council reviewers (2026-07-25).
 *
 * `runAgentStep` used to publish every session into the run's singular
 * `state.session` / `state.interrupt` slots. That is fine while exactly one
 * agent runs at a time — and unsafe the moment reviewers fan out, because the
 * last session started overwrites the rest and becomes the ONLY one `cancel()`
 * can reach. The others keep running, and keep billing, with a Stop button that
 * silently does nothing.
 *
 * The fix is `ActiveRun.liveSessions`: every session registers there regardless
 * of concurrency, and `cancel()` interrupts all of them. These tests pin that
 * contract against a faithful model of the code paths involved, so a future
 * edit that reintroduces "last writer wins" fails here.
 */

interface FakeSession {
  id: string;
  interrupted: boolean;
  interrupt(): void;
}

interface FakeState {
  cancelled: boolean;
  interrupt: () => void;
  session?: FakeSession;
  liveSessions: Set<FakeSession>;
}

const makeSession = (id: string): FakeSession => ({
  id,
  interrupted: false,
  interrupt() {
    this.interrupted = true;
  },
});

/** Mirrors `runAgentStep`'s registration: always tracked; the singular slots
 *  are claimed only by a non-concurrent session. */
function register(state: FakeState, session: FakeSession, concurrent: boolean): void {
  state.liveSessions.add(session);
  if (!concurrent) {
    state.session = session;
    state.interrupt = () => session.interrupt();
  }
}

/** Mirrors `RunManager.cancel`. */
function cancel(state: FakeState): void {
  state.cancelled = true;
  state.interrupt();
  for (const session of state.liveSessions) {
    try {
      session.interrupt();
    } catch {
      /* already gone */
    }
  }
}

const freshState = (): FakeState => ({
  cancelled: false,
  interrupt: () => undefined,
  liveSessions: new Set(),
});

describe('cancel() with concurrent phase sessions', () => {
  it('interrupts EVERY reviewer running in parallel, not just the last one started', () => {
    const state = freshState();
    const reviewers = ['r1', 'r2', 'r3'].map(makeSession);
    for (const s of reviewers) register(state, s, true);

    cancel(state);

    expect(reviewers.map((s) => s.interrupted)).toEqual([true, true, true]);
  });

  it('leaves the singular slots untouched for concurrent phases', () => {
    const state = freshState();
    const reviewers = ['r1', 'r2'].map(makeSession);
    for (const s of reviewers) register(state, s, true);

    // Nothing claimed `state.session` — so nothing could be clobbered.
    expect(state.session).toBeUndefined();
  });

  it('still interrupts a single non-concurrent session (the interactive path is unchanged)', () => {
    const state = freshState();
    const only = makeSession('main');
    register(state, only, false);

    cancel(state);

    expect(only.interrupted).toBe(true);
    expect(state.session).toBe(only);
  });

  it('interrupts a mixed set — one interactive session beside parallel reviewers', () => {
    const state = freshState();
    const main = makeSession('main');
    const reviewers = ['r1', 'r2'].map(makeSession);
    register(state, main, false);
    for (const s of reviewers) register(state, s, true);

    cancel(state);

    expect(main.interrupted).toBe(true);
    expect(reviewers.every((s) => s.interrupted)).toBe(true);
  });

  it('keeps cancelling the rest when one session throws on interrupt', () => {
    const state = freshState();
    const bad: FakeSession = {
      id: 'bad',
      interrupted: false,
      interrupt() {
        throw new Error('already exited');
      },
    };
    const good = makeSession('good');
    register(state, bad, true);
    register(state, good, true);

    expect(() => cancel(state)).not.toThrow();
    expect(good.interrupted).toBe(true);
  });

  it('drops a finished session from the live set so cancel does not touch it', () => {
    const state = freshState();
    const done = makeSession('done');
    const running = makeSession('running');
    register(state, done, true);
    register(state, running, true);
    state.liveSessions.delete(done); // runAgentStep's `finally`

    cancel(state);

    expect(done.interrupted).toBe(false);
    expect(running.interrupted).toBe(true);
  });
});

describe('the real implementation still honours the contract', () => {
  const source = readFileSync(join(import.meta.dirname, 'run.ts'), 'utf8');

  it('cancel() interrupts every live session, not only state.interrupt', () => {
    const cancelBody = source.slice(source.indexOf('  cancel(runId: string): boolean {'));
    expect(cancelBody).toMatch(/for \(const session of state\.liveSessions\)/);
    expect(cancelBody).toMatch(/session\.interrupt\(\)/);
  });

  it('every session registers in liveSessions regardless of concurrency', () => {
    expect(source).toMatch(/state\.liveSessions\.add\(session\)/);
    expect(source).toMatch(/state\.liveSessions\.delete\(session\)/);
  });

  it('a concurrent phase never claims the singular session slots', () => {
    // The guard that makes parallel reviewers safe.
    expect(source).toMatch(/if \(!concurrentPhase\) \{\s*\n\s*state\.session = session;/);
  });

  it('the phase turn-end handler targets its own session, never the shared slot', () => {
    const start = source.indexOf('if (phaseResultPath) {');
    const phaseBranch = source.slice(
      start,
      source.indexOf('const sessionOpen = !state.cancelled', start),
    );
    expect(phaseBranch.length).toBeGreaterThan(0);
    expect(phaseBranch).toMatch(/liveSession\?\.open/);
    expect(phaseBranch).not.toMatch(/state\.session/);
  });
});
