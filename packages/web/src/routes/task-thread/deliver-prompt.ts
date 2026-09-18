import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { ApiError } from '@/api/client'
import { runQueryOptions, useSendMessage } from '@/api/queries'
import type { ApiRun, AttachmentInput, RunStatus } from '@open-mercato/cezar-api-client'

import type { ContinueAction } from './follow-up-engine'
import { isIdleTeardownRefusal } from './ask-answer'
import { lastSessionId } from './run-actions'

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
 *    resume), and re-posting it would only turn one honest error into two;
 *  - reopen a session for an EMPTY draft. Submitting nothing is the one-click Continue, and a
 *    run that turns out to be live has nothing to continue — there is no message to deliver;
 *  - retry more than once. The second answer is reported as it comes.
 */

/** Which endpoint a record's status calls for. `queued` is `live`: the message is folded into
 *  the prompt (#472), which is the same `POST /messages` the open session takes. */
export type DeliveryPath = 'live' | 'continue'

export function deliveryPath(status: RunStatus): DeliveryPath {
  return status === 'running' || status === 'waiting' || status === 'queued' ? 'live' : 'continue'
}

export type DeliverPrompt = (text: string, images: AttachmentInput[]) => Promise<unknown>

export function useDeliverPrompt(run: ApiRun, continueAction: ContinueAction): DeliverPrompt {
  const queryClient = useQueryClient()
  // `mutateAsync` is referentially stable (the mutation RESULT is not — see the thread's `edit`
  // memo for the same rule), so this callback is stable across the streaming re-renders a live
  // thread does constantly.
  const { mutateAsync: sendMessageAsync } = useSendMessage(run.id)
  const { continueWith } = continueAction

  return useCallback(
    async (text: string, images: AttachmentInput[]) => {
      const deliver = (path: DeliveryPath, retryTeardown = false) =>
        path === 'live'
          ? sendMessageAsync({ text, images })
          : continueWith(text, images, { retryTeardown })
      const attempted = deliveryPath(run.status)
      try {
        return await deliver(attempted)
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error
        let fresh: ApiRun
        try {
          fresh = await queryClient.fetchQuery({ ...runQueryOptions(run.id), staleTime: 0 })
        } catch {
          // The refetch is the recovery, not the delivery: if it cannot answer, the user still
          // gets the server's own words about the send they made.
          throw error
        }
        const path = deliveryPath(fresh.status)
        // The first Continue was intentionally single-shot so this refetch could distinguish a
        // stale route from a real teardown race. If the fresh record still agrees, hand the exact
        // refusal back to ContinueAction's bounded retry rather than retrying a different route.
        if (path === attempted) {
          if (path === 'continue' && isIdleTeardownRefusal(error)) return await deliver(path, true)
          throw error
        }
        // Nothing to say and the run is already live: the empty submit was "reopen the session",
        // and it is open. The 409 says exactly that, and the refetch above has already put the
        // truth in the cache.
        if (path === 'live' && text.trim() === '' && images.length === 0) throw error
        // A record with no session to resume cannot take this prompt either — `POST /continue`
        // would answer its own 409, which would read as the new failure rather than the real one.
        // Judged on the FRESH record: `continueAction.available` was computed from the stale one,
        // which in this direction is precisely the record that says the run is still live.
        if (path === 'continue' && lastSessionId(fresh) === undefined) throw error
        return await deliver(path, path === 'continue')
      }
    },
    [continueWith, queryClient, run.id, run.status, sendMessageAsync],
  )
}
