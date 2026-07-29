import { useState } from 'react'

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
  /** Deliver the answer. Never rejects: a failure lands in `error` so the card can show it. */
  send: (text: string) => Promise<void>
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
 */
export function useAskAnswer(run: ApiRun): AskAnswerDelivery {
  const sendMessage = useSendMessage(run.id)
  const resume = useContinueRun(run.id)
  const activeProvider = useActiveProviderAvailability(run)
  const existingProvider = useExistingProviderAvailability(run)
  const [error, setError] = useState<string | undefined>(undefined)

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

  const send = async (text: string): Promise<void> => {
    // Defense in depth — every entry point is already disabled while blocked, and the card
    // renders `reason` on its own, so repeating it as an error would say the same thing twice.
    if (blockedBy) return
    setError(undefined)
    if (mode === 'resume') {
      try {
        await resumeWith(text)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    try {
      await sendMessage.mutateAsync({ text })
    } catch (err) {
      // The cached record said "live" but the session had already closed — resume instead
      // of dropping the answer the user just gave. Only ever from the live path: a resume
      // that answers 409 has already been refused on its own terms.
      if (err instanceof ApiError && err.status === 409 && lastSessionId(run) !== undefined) {
        try {
          await resumeWith(text)
          return
        } catch (resumeErr) {
          setError(resumeErr instanceof Error ? resumeErr.message : String(resumeErr))
          return
        }
      }
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return {
    mode,
    blockedBy,
    reason,
    isPending: sendMessage.isPending || resume.isPending,
    error,
    send,
  }
}
