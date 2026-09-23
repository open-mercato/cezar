import { useRef, useState } from 'react'

import { ApiError } from '@/api/client'
import { useContinueRun, useSendMessage } from '@/api/queries'
import type { ApiRun, RunRecord } from '@open-mercato/cezar-api-client'

import {
  useActiveProviderAvailability,
  useExistingProviderAvailability,
} from './active-provider'
import { isRunActive, lastSessionId, runActionFlags } from './run-actions'

/**
 * Which seam an AskUser answer travels on.
 *
 *  - `live`    — the engine still owns a session (or the run has not started yet):
 *                `POST /api/runs/:id/messages`, exactly as the ask card always did.
 *  - `resume`  — the session ENDED while the question was still unanswered (idle
 *                timeout, a cezar restart, Finish, or a cancel). The answer becomes
 *                the opening prompt of `POST /api/runs/:id/continue`, which reopens
 *                the last recorded session and appends the answer as a
 *                `user-message` — the very event that resolves the card.
 *  - `unavailable` — the run is closed and never recorded a session, so there is
 *                nothing to reopen and the answer has nowhere to go.
 */
export type AskDeliveryMode = 'live' | 'resume' | 'unavailable'

/** Why an answer cannot be delivered right now — `provider` is recoverable from
 *  Settings, `no-session` is terminal for this run. */
export type AskBlockedReason = 'provider' | 'no-session'

/** The idle timer closes the backend before the RunManager has finished settling
 *  the run record and releasing its active-run entry. A stale ask card can therefore
 *  learn that `/messages` is closed, then reach `/continue` a few milliseconds too
 *  early. Retry only that exact transitional refusal; every other 409 is actionable. */
export const IDLE_TEARDOWN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000] as const

const delayIdleTeardownRetry = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs))

function isIdleTeardownRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.message === 'run is still active'
}

/** Reopen once the old idle-closed session has left the RunManager's active map.
 *  The injected wait keeps the bounded policy deterministic in unit tests. */
export async function resumeAfterIdleTeardown<T>(
  resume: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = delayIdleTeardownRetry,
): Promise<T> {
  for (let retries = 0; ; retries += 1) {
    try {
      return await resume()
    } catch (error) {
      const delayMs = IDLE_TEARDOWN_RETRY_DELAYS_MS[retries]
      if (!isIdleTeardownRefusal(error) || delayMs === undefined) throw error
      await wait(delayMs)
    }
  }
}

/**
 * The delivery route for one ask answer, as a pure function of the run record — the
 * same shape `runActionFlags` has, so a table test can pin it per status. Mirrors the
 * composer's own routing (`ThreadView`: a live/queued run sends, a closed one with a
 * session continues), which is exactly the seam the ask card was missing.
 */
export function askDeliveryMode(run: RunRecord): AskDeliveryMode {
  if (isRunActive(run.status)) return 'live'
  return runActionFlags(run).continueRun ? 'resume' : 'unavailable'
}

export interface AskAnswerDelivery {
  mode: AskDeliveryMode
  /** Set when the answer cannot be delivered at all; the card renders `reason` and stays inert. */
  blockedBy?: AskBlockedReason
  reason?: string
  /** A delivery is in flight — the option chips and Send stay disabled until it settles. */
  isPending: boolean
  /** The server's own words for the last failed delivery, cleared when a new one starts. */
  error?: string
  /**
   * Deliver the answer. Never rejects: a failure lands in `error` AND comes back from the call,
   * which is one fact offered two ways because two kinds of caller need it differently. The ask
   * card renders `error` inline and ignores the return; a one-shot caller (the header's "Resolve
   * conflicts" button) has closed its panel by then and needs the answer where it acted, to
   * toast. `undefined` is success.
   */
  send: (text: string) => Promise<string | undefined>
}

/**
 * Deliver an AskUser answer on whichever seam the run's current state allows, so a
 * question the agent asked stays answerable after its session ends — answering
 * reopens the session with the answers as its prompt.
 *
 * The provider gate follows the seam: a live message is gated on the provider the
 * server would use for `POST /messages` (`useActiveProviderAvailability`), while a
 * resume is gated on the run's recorded provider. Unlike the composer's explicit
 * runner picker, an Ask answer never falls back to another connected engine silently.
 *
 * A `409` from the live path is not a dead end but a stale cache: the record claimed a
 * session the server no longer has (a dropped SSE frame, a long-open tab). When the run
 * has a session id to resume, the answer is retried as a resume rather than lost —
 * `useSendMessage` has already invalidated the record by then, so the card's next render
 * agrees.
 *
 * Not only the ask card's seam: this is the route for ANY text that has to reach a run whatever
 * state the run is in, and the header's one-click prompts ("Resolve conflicts") ride it for the
 * same reason the card does — a task parked at `review` has no live session, and a prompt that
 * only worked on a running task would be offered exactly when it could not be taken.
 */
export function useAskAnswer(run: ApiRun, projectId?: string): AskAnswerDelivery {
  // `projectId` only from a surface standing OUTSIDE the run's project — the global Tasks page.
  // Everywhere else the scope is already the run's own and naming it would be noise.
  const sendMessage = useSendMessage(run.id, projectId)
  const resume = useContinueRun(run.id, projectId)
  const activeProvider = useActiveProviderAvailability(run)
  const existingProvider = useExistingProviderAvailability(run)
  const [error, setError] = useState<string | undefined>(undefined)
  const [delivering, setDelivering] = useState(false)
  const deliveringRef = useRef(false)

  const mode = askDeliveryMode(run)
  const providerBlocked =
    mode === 'resume' ? !existingProvider.usable
    : mode === 'live' ? !activeProvider.usable
    : false
  const blockedBy: AskBlockedReason | undefined =
    mode === 'unavailable' ? 'no-session'
    : providerBlocked ? 'provider'
    : undefined
  const reason =
    blockedBy === 'no-session'
      ? 'This session has ended and no agent session was recorded, so the answer cannot be delivered.'
      : blockedBy === 'provider'
        ? (mode === 'resume' ? existingProvider.reason : activeProvider.reason)
        : undefined

  const resumeWith = (text: string) => {
    if (!existingProvider.usable) {
      return Promise.reject(new Error(existingProvider.reason ?? 'The run provider is unavailable.'))
    }
    // No runner override: the server keeps the run's own backend and model, so answering a
    // question cannot silently switch engines when another provider happens to be connected.
    return resume.mutateAsync({ text })
  }

  const send = async (text: string): Promise<string | undefined> => {
    // Defense in depth — every entry point is already disabled while blocked, and the card
    // renders `reason` on its own, so repeating it as an error would say the same thing twice.
    // The REASON still comes back, for the caller that has no `reason` on screen to repeat.
    if (blockedBy || deliveringRef.current) return reason
    deliveringRef.current = true
    setDelivering(true)
    setError(undefined)
    try {
      if (mode === 'resume') {
        await resumeAfterIdleTeardown(() => resumeWith(text))
        return undefined
      }
      try {
        await sendMessage.mutateAsync({ text })
      } catch (sendError) {
        // The cached record said "live" but the session had already closed — resume instead
        // of dropping the answer the user just gave. The old session can still be settling
        // after the message 409, so the continuation helper owns that narrow retry window.
        if (
          sendError instanceof ApiError &&
          sendError.status === 409 &&
          lastSessionId(run) !== undefined
        ) {
          await resumeAfterIdleTeardown(() => resumeWith(text))
          return undefined
        }
        throw sendError
      }
      return undefined
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      return message
    } finally {
      deliveringRef.current = false
      setDelivering(false)
    }
  }

  return {
    mode,
    blockedBy,
    reason,
    isPending: delivering || sendMessage.isPending || resume.isPending,
    error,
    send,
  }
}
