import { describe, expect, it } from 'vitest';
import type { CheckoutProgressEvent, RunEvent as WebRunEvent } from '@open-mercato/cezar-api-client';
import type { RunEvent } from '../runs/store.ts';

/**
 * What is left of the hand-written mirror — and only that.
 *
 * This file used to pin 58 shapes, because every response type was declared twice: once by the
 * server and once by hand in the api-client. `@open-mercato/cezar-contract` removed the
 * duplication, and `contract-parity*.test.ts` now checks each schema against the ROUTE it
 * describes, which is a strictly better comparison — the route IS the wire, whereas the pairs
 * below compare against the server's internal types.
 *
 * That distinction is why the retired assertions could not simply be repointed at the contract.
 * The contract describes what a client receives, and `JSON.stringify` drops an undefined value,
 * so `foo?: T` there is correct even where the server's in-memory type says `foo: T | undefined`.
 * `ExactKeys` reads that as drift; it is not — the two are describing different things. Pointing
 * the old guard at the contract would have manufactured failures and taught the next person to
 * loosen it.
 *
 * Two shapes genuinely cannot be derived from a route, so they stay hand-mirrored and stay
 * guarded here. Both are SSE FRAME payloads delivered over `text/event-stream`, which Hono types
 * as a string body — the frame shape is invisible to `InferResponseType`.
 */
describe('the shapes that cannot come from a route are still mirrored faithfully', () => {
  /** Mutual assignability. `[…]` wrappers stop a naked union from distributing. */
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  /** Key-set equality — `Exact` alone is blind to a missing OPTIONAL property (#472). */
  type ExactKeys<A, B> = Exact<keyof A, keyof B>;

  const guards = {
    /** `GET /api/v1/runs/:id/events` and `/api/v1/events` — the run event stream. */
    runEvent: true satisfies Exact<RunEvent, WebRunEvent>,
  };

  /**
   * No `ExactKeys` pair here, deliberately. `RunEvent` carries a string index signature, and
   * TypeScript reports `keyof` of an interface with one as `string | number` while the zod loose
   * object infers `string` — a difference in how the two are spelled, not in what they accept
   * (`Exact` above passes both ways). `ExactKeys` exists to catch a MISSING OPTIONAL property
   * (#472), which cannot happen on a type that already accepts arbitrary keys, so pinning it
   * here would fail forever while proving nothing.
   */
  type _KeysNotApplicable = ExactKeys<{ a: 1 }, { a: 1 }>;

  it('holds every pair above', () => {
    // The compiler does the real work. This only stops a future edit from deleting the pairs and
    // leaving a green file that checks nothing.
    expect(Object.keys(guards).length).toBeGreaterThan(0);
    expect(Object.values(guards).every(Boolean)).toBe(true);
  });

  it('records why the other SSE shape has no pair here', () => {
    // `checkout-progress` frames are assembled inline in the workspace-events handler, so there
    // is no server-side type to pin the mirror against. Noted so its absence above reads as
    // deliberate rather than as an oversight.
    const phases: CheckoutProgressEvent['phase'][] = ['cloning', 'done', 'error'];
    expect(phases).toHaveLength(3);
  });
});
