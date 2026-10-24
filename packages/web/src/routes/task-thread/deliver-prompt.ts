import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { ApiError } from '@/api/client'
import { runQueryOptions, useSendMessage } from '@/api/queries'
import type { ApiRun, AttachmentEntry, MessageSurface, RunStatus } from '@open-mercato/cezar-api-client'

import type { ContinueAction } from './follow-up-engine'
import { lastSessionId } from './run-actions'
import { trackMessageSent } from '@/lib/telemetry'

/**
 * The composer's one delivery path — and its recovery when the record it aimed by was stale.
 *
 * A prompt typed into the thread reaches the agent one of two ways, and the run's status picks
 * which: a live session takes `POST /messages`, a closed one takes `POST /continue`. The record
 * is authoritative for that choice, and the record can be wrong — the workspace stream can lose
 * the update that flipped it (run-reconcile.ts has the full account), and nothing refetches it
 * until something asks. The composer then posts to the wrong endpoint, the server answers 409,
 * and the reply the user typed bounces back into the draft. Typing it again does not help:
 * every retry aims by the same stale record, which is why the only cure was a page reload.
 *
 * So a 409 is not the end here. It is the server saying "the record you aimed by is not the run
 * I have", and the answer is to ASK — one authoritative refetch (`staleTime: 0`, so the
 * cockpit's five-minute staleTime cannot answer from the same stale entry) — and, when the fresh
 * record names the other path, deliver on that path instead. The prompt lands, and the refetch
 * has healed the cache every other view reads, so the thread stops lying in the same beat.
 *
 * What it deliberately does NOT do:
 *  - retry when the fresh record agrees with the path already tried. That 409 is the server's
 *    considered answer (a disconnected provider, a locked model, a session with nothing to
 *    resume), and re-posting it would only turn one honest error into two. The two exceptions are
 *    the transitional refusals, retried on a bounded backoff (`SESSION_GAP_RETRY_DELAYS_MS`): the
 *    live path's `session closed` (a `running` run between sessions) and the Continue path's
 *    `run is still active` (a run whose record already settled while the engine still unwinds it);
 *  - re-post a request that got no answer at all, unless a fresh record proves it never landed.
 *    Only Continue can prove that: an accepted one adds its step synchronously (7adbfbd7);
 *  - reopen a session for an EMPTY draft that a fresh record AGREES is settled — a genuine
 *    refusal. But an EMPTY draft whose refusal is `run is still active` is the opposite: the
 *    refetch proves the run is live already, which is the state the one-click Continue asked
 *    for, so nothing is delivered and nothing failed (telemetry 77117b95);
 *  - retry beyond that bound. The last answer is reported as it comes.
 */

/** Which endpoint a record's status calls for. `queued` is `live`: the message is folded into
 *  the prompt (#472), which is the same `POST /messages` the open session takes. */
export type DeliveryPath = 'live' | 'continue'

export function deliveryPath(status: RunStatus): DeliveryPath {
  return status === 'running' || status === 'waiting' || status === 'queued' ? 'live' : 'continue'
}

export type DeliverPrompt = (text: string, images: AttachmentEntry[]) => Promise<unknown>

/** A `running` run can be between sessions: settling after its last turn, or between two workflow
 *  steps. `/messages` answers `session closed` while the record still names the live path, so wait
 *  (bounded, ~10s) for it to settle into Continue or for the next session to open (telemetry 1408d7cb). */
export const SESSION_GAP_RETRY_DELAYS_MS = [250, 500, 1_000, 1_000, 2_000, 2_000, 3_000] as const

const delaySessionGapRetry = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))

function isSessionClosed(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.message === 'session closed'
}

/** The record settles (review/done) BEFORE the engine drops the run — a Continue's turn-end autosave
 *  runs in between — so `/continue` refuses a run its own fresh record calls settled (77117b95). */
function isStillUnwinding(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.message === 'run is still active'
}

/** The refusal on `path` that only means "not yet": worth the bounded wait, never a verdict. */
function isTransitional(path: DeliveryPath, error: unknown): error is ApiError {
  return path === 'live' ? isSessionClosed(error) : isStillUnwinding(error)
}

const continuations = (record: ApiRun) => record.steps.filter((step) => step.id.startsWith('continue-')).length

export function useDeliverPrompt(
  run: ApiRun,
  continueWith: ContinueAction['continueWith'],
  opts: {
    wait?: (delayMs: number) => Promise<void>
    /** The `message_sent` label for a delivery that landed through this seam. Every caller of one
     *  thread's composer is `existing_session`; the review gate's notes are `review`. `null` counts
     *  nothing — the footer's one-click Continue was never a `message_sent` (#1473 review). */
    surface?: Exclude<MessageSurface, 'cli'> | null
  } = {},
): DeliverPrompt {
  const { wait = delaySessionGapRetry, surface = 'existing_session' } = opts
  const queryClient = useQueryClient()
  // `mutateAsync` is referentially stable (the mutation RESULT is not — see the thread's `edit`
  // memo for the same rule), so this callback is stable across the streaming re-renders a live
  // thread does constantly.
  const { mutateAsync: sendMessageAsync } = useSendMessage(run.id)
  const knownContinuations = continuations(run)

  return useCallback(
    async (text: string, images: AttachmentEntry[]) => {
      const deliver = async (path: DeliveryPath) => {
        const result = await (path === 'live' ? sendMessageAsync({ text, images }) : continueWith(text, images))
        if (surface) trackMessageSent(surface)
        return result
      }
      const refetch = () => queryClient.fetchQuery({ ...runQueryOptions(run.id), staleTime: 0 })
      const attempted = deliveryPath(run.status)
      let firstError: unknown
      try {
        return await deliver(attempted)
      } catch (error) {
        firstError = error
      }
      // No answer at all (status 0: a dropped socket, a restarting server). Re-post a Continue only
      // when the fresh record still shows no new continuation step, so it cannot land twice.
      if (attempted === 'continue' && firstError instanceof ApiError && firstError.status === 0) {
        const fresh = await refetch().catch(() => undefined)
        if (!fresh || deliveryPath(fresh.status) !== 'continue' || continuations(fresh) !== knownContinuations) {
          throw firstError
        }
        try {
          return await deliver('continue')
        } catch (retryError) {
          firstError = retryError
        }
      }
      if (!(firstError instanceof ApiError) || firstError.status !== 409) throw firstError
      let refusal: ApiError = firstError
      for (let retry = 0; ; retry += 1) {
        let fresh: ApiRun
        try {
          fresh = await refetch()
        } catch {
          // The refetch is the recovery, not the delivery: if it cannot answer, the user still
          // gets the server's own words about the send they made.
          throw refusal
        }
        const path = deliveryPath(fresh.status)
        if (path === attempted) {
          // Only a transitional refusal is worth the wait; any other agreeing 409 is the server's
          // considered answer.
          const delayMs = isTransitional(attempted, refusal) ? SESSION_GAP_RETRY_DELAYS_MS[retry] : undefined
          if (delayMs === undefined) throw refusal
          await wait(delayMs)
          try {
            return await deliver(attempted)
          } catch (retryError) {
            if (!isTransitional(attempted, retryError)) throw retryError
            refusal = retryError
            continue
          }
        }
        // Nothing to say and the run is already live: the empty submit was "reopen the session",
        // and it is already open — the very state the one-click Continue asked for. The refetch
        // above has already put the truth in the cache, so the thread redraws live instead of
        // lying. Nothing was meant to be delivered, so this is a success, not the false failure
        // the toast made of it (telemetry 77117b95).
        if (path === 'live' && text.trim() === '' && images.length === 0) return undefined
        // A record with no session to resume cannot take this prompt either — `POST /continue`
        // would answer its own 409, which would read as the new failure rather than the real one.
        // Judged on the FRESH record: `continueAction.available` was computed from the stale one,
        // which in this direction is precisely the record that says the run is still live.
        if (path === 'continue' && lastSessionId(fresh) === undefined) throw refusal
        return await deliver(path)
      }
    },
    [continueWith, knownContinuations, queryClient, run.id, run.status, sendMessageAsync, surface, wait],
  )
}
