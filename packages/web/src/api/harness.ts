// The harness API surface, apart from `client`/`queries` so the cockpit's eager bundle never carries
// it: only the lazily loaded harness views and the Multi-model composer import it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryScope } from '@open-mercato/cezar-api-client'
import type {
  HarnessAcceptContestedResponse,
  HarnessCouncilDecisionInput,
  HarnessCouncilDecisionResponse,
  HarnessInvocationDetail,
  HarnessInvocationRecord,
  HarnessLedgerResponse,
  HarnessProbeResponse,
  HarnessRoles,
  HarnessStatusResponse,
  HarnessReviewActionInput,
} from '@open-mercato/cezar-api-client'

import { cez, init, runPath, unwrap, type ReadOptions } from './client'
import { queryKeys } from './queries'

/** Installed/configured harness summary + the model roster for Settings and the composer. */
export async function getHarnessStatus(opts?: ReadOptions): Promise<HarnessStatusResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].harness.status.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/harness/status',
  )
}

/** Readiness of one lineup before starting a harness run. */
export async function probeHarness(roles: HarnessRoles): Promise<HarnessProbeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].harness.probe.$post({
      param: { projectId: queryScope() },
      json: { roles },
    }),
    '/harness/probe',
  )
}

/** One reviewer invocation's prompt and result — the conversation behind a
 *  verdict. Fetched on demand: prompts embed diff context and are far too large
 *  to ride along with every ledger read. */
export async function getHarnessInvocation(
  id: string,
  invocationId: string,
  opts: ReadOptions = {},
): Promise<HarnessInvocationDetail> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].harness.invocations[':invocationId'].$get(
      { param: { projectId: queryScope(), id, invocationId } },
      init(opts),
    ),
    runPath(id, `/harness/invocations/${encodeURIComponent(invocationId)}`),
  )
}

/** Resolve a council paused below quorum: `retry` buys the failed reviewers one
 *  more attempt, `proceed` continues with the survivors. Recorded in the ledger
 *  and the run resumes immediately (council resilience 2026-07-29). */
export async function councilDecision(
  id: string,
  action: HarnessCouncilDecisionInput['action'],
): Promise<HarnessCouncilDecisionResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].harness['council-decision'].$post({
      param: { projectId: queryScope(), id },
      json: { action },
    }),
    runPath(id, '/harness/council-decision'),
  )
}

/** Explicitly accept a contested harness result before publishing it. The reason is retained
 *  in the durable ledger; this is intentionally separate from commit/push/PR actions. */
export async function acceptContestedHarness(
  id: string,
  reason: string,
): Promise<HarnessAcceptContestedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].harness['accept-contested'].$post({
      param: { projectId: queryScope(), id },
      json: { reason },
    }),
    runPath(id, '/harness/accept-contested'),
  )
}

/** A reviewer's conversation, cached per invocation revision: a feedback continuation may
 *  reuse the invocation id and rewrite its prompt/result artifacts. */
export function useHarnessInvocation(
  id: string | undefined,
  invocationId: string | null,
  revision?: HarnessInvocationRecord,
) {
  return useQuery({
    queryKey: [
      ...queryKeys.runs.harness(id ?? ''), 'invocation', invocationId ?? '',
      revision?.inputSha256, revision?.status, revision?.attempt,
      revision?.startedAt, revision?.endedAt, revision?.artifactSha256,
    ] as const,
    queryFn: ({ signal }) => getHarnessInvocation(id as string, invocationId as string, { signal }),
    enabled: Boolean(id) && Boolean(invocationId),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useAcceptContestedHarness(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reason: string) => acceptContestedHarness(id, reason),
    onSuccess: ({ outcome, decisions, resumed }) => {
      if (resumed) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs.harness(id) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(id) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
        return
      }
      // BOTH halves, or publishing never unlocks (review 2026-07-27): the gate
      // requires the matching `accept-contested` decision row as well as the
      // acceptance stamp on `outcome`, and this query never refetches on its own
      // (`staleTime: Infinity`, no polling), so a partial patch is permanent —
      // the panel said "accepted" while Finish and Draft PR stayed disabled.
      queryClient.setQueryData<HarnessLedgerResponse>(
        queryKeys.runs.harness(id),
        (ledger) => {
          if (!ledger) return ledger
          const rows =
            decisions ??
            (outcome.acceptedAt && outcome.acceptanceReason
              ? [
                  ...(ledger.decisions ?? []),
                  {
                    at: outcome.acceptedAt,
                    kind: 'accept-contested',
                    by: outcome.acceptedBy ?? 'user',
                    detail: outcome.acceptanceReason,
                  },
                ]
              : ledger.decisions)
          return { ...ledger, outcome, ...(rows ? { decisions: rows } : {}) }
        },
      )
    },
  })
}

/** Resolve a paused council: retry the failed reviewers or proceed with the
 *  survivors. The run resumes server-side, so the run + ledger queries are
 *  invalidated rather than patched — the driver rewrites both immediately. */
export function useCouncilDecision(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (action: 'retry' | 'proceed') => councilDecision(id, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.harness(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
    },
  })
}

export function useHarnessReviewAction(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: HarnessReviewActionInput) => unwrap(
      await cez.api.v1.p[':projectId'].runs[':id'].harness['review-action'].$post({
        param: { projectId: queryScope(), id }, json: input,
      }),
      runPath(id, '/harness/review-action'),
    ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.harness(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
    },
  })
}

/** Installed/configured harness summary + model roster (Settings → Harness, composer panel). */
export function useHarnessStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.harness.status,
    queryFn: ({ signal }) => getHarnessStatus({ signal }),
    enabled,
    // "Configure models" rewrites the roster on disk; a cached answer hid it for five minutes.
    // Status is a cheap config read — the billed probe keeps its cache.
    refetchOnMount: 'always',
  })
}

/** Probe one lineup's readiness. Keyed per lineup so switching back shows its cached answer
 *  instantly; probes are live model calls, so the cache stands. */
export function useHarnessProbe(roles: HarnessRoles | null) {
  return useQuery({
    queryKey: queryKeys.harness.probe(JSON.stringify(roles)),
    queryFn: () => probeHarness(roles!),
    enabled: roles !== null,
  })
}
