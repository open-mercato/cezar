import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import type { JSONParsed, JSONValue } from 'hono/utils/types';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  harnessAcceptContestedResponseSchema,
  harnessCouncilDecisionResponseSchema,
  harnessInvocationDetailSchema,
  harnessLedgerResponseSchema,
  harnessProbeResponseSchema,
  harnessStatusResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `contract/harness.ts` must describe EXACTLY what the six harness routes send.
 *
 * Same guard as its siblings, same reasoning: both directions, because one-way assignability is
 * green on real drift, and `InferResponseType` reads what the ROUTE answers rather than what a
 * handler was annotated with. Compile-time; `npm run typecheck` enforces it.
 */
describe('src/contract/harness.ts matches the harness routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  /** For a schema holding an open bag (an invocation's `binding`, the ledger's `outcome`): its
   *  catchall infers `unknown`, which `c.json` types as hono's `JSONValue` — see
   *  `contract-parity.workspace.test.ts` for the full argument. Compared as its JSON image. */
  type ExactOpen<Schema, Route> = Mutual<JSONParsed<Schema>, Route>;
  type Assert<T extends true> = T;

  type Harness = typeof client.api.v1.harness;
  type RunHarness = (typeof client.api.v1.runs)[':id']['harness'];

  type Status200 = InferResponseType<Harness['status']['$get'], 200>;
  type Probe200 = InferResponseType<Harness['probe']['$post'], 200>;
  type Ledger200 = InferResponseType<RunHarness['$get'], 200>;
  type Invocation200 = InferResponseType<RunHarness['invocations'][':invocationId']['$get'], 200>;
  type Accept200 = InferResponseType<RunHarness['accept-contested']['$post'], 200>;
  type Council200 = InferResponseType<RunHarness['council-decision']['$post'], 200>;

  /**
   * The ledger is an open bag on both sides, but not the same one. The server persists councils
   * and packets as open records (`harness/types.ts`, reserved shapes) that the cockpit's reader
   * schema structures at parse time, and its private bookkeeping (subject, trusted skills,
   * validation evidence…) rides the catchall unnamed. Every key both sides type is pinned
   * exactly; `decisions`, `loops` and `snapshotSeq` — always sent, optional to the reader — are
   * pinned by type.
   */
  type Ledger = z.infer<typeof harnessLedgerResponseSchema>;
  type LedgerKeys =
    | 'version'
    | 'workflow'
    | 'requestedProfile'
    | 'effectiveProfile'
    | 'skillProfile'
    | 'phases'
    | 'models'
    | 'invocations'
    | 'pendingMessages'
    | 'stage'
    | 'outcome';
  type LedgerAlwaysSent = 'decisions' | 'loops' | 'snapshotSeq';

  type _Checks = [
    Assert<Exact<z.infer<typeof harnessStatusResponseSchema>, Status200>>,
    Assert<Exact<z.infer<typeof harnessProbeResponseSchema>, Probe200>>,
    Assert<ExactOpen<Pick<Ledger, LedgerKeys>, Pick<Ledger200, LedgerKeys>>>,
    Assert<ExactOpen<Required<Pick<Ledger, LedgerAlwaysSent>>, Pick<Ledger200, LedgerAlwaysSent>>>,
    Assert<ExactOpen<z.infer<typeof harnessInvocationDetailSchema>, Invocation200>>,
    Assert<ExactOpen<z.infer<typeof harnessAcceptContestedResponseSchema>, Accept200>>,
    Assert<Exact<z.infer<typeof harnessCouncilDecisionResponseSchema>, Council200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    const openDrift: ExactOpen<
      { a: number; [k: string]: unknown },
      { a: string; [k: string]: JSONValue }
    > = 'schema-is-wider';
    expect([wider, narrower, openDrift]).toEqual(['schema-is-wider', 'route-is-wider', 'schema-is-wider']);
  });
});
