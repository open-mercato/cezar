import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { putConfig } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { SetConfigInput } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'
import { useSavedFlash } from './form-row'

/**
 * The one `PUT /api/v1/config` mutation every project settings section shares (Agents,
 * Instructions, Tasks). The PUT answers the full knob shape, which lands straight in the
 * `config` query — the readback is the server's own truth, not an optimistic guess. The same
 * knobs surface elsewhere (defaultRunner in /api/health, baseBranch in /api/repo), so both are
 * refreshed too; the composer and the Git view must agree immediately.
 *
 * `savedFor(key)` is the inline "Saved" of the one `FormRow` whose patch just landed: the first
 * key of the patch names the row (design doc, Proposal 9 — one save model per page).
 */
export function useConfigSave() {
  const queryClient = useQueryClient()
  const { savedFor, markSaved } = useSavedKeys()
  const mutation = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result, patch) => {
      queryClient.setQueryData(queryKeys.config, result)
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      markSaved(Object.keys(patch)[0] ?? null)
    },
    // 400/409/500 alike: the server's own words, verbatim (the repo-wide error doctrine).
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  return Object.assign(mutation, { savedFor })
}

/** `useSavedFlash` keyed by row: `markSaved('reviewGate')` makes `savedFor('reviewGate')` true
 *  for two seconds, and every other row stays quiet. */
export function useSavedKeys() {
  const [saved, flash] = useSavedFlash()
  const [key, setKey] = useState<string | null>(null)
  return {
    savedFor: (candidate: string) => saved && key === candidate,
    markSaved: (next: string | null) => {
      setKey(next)
      flash()
    },
  }
}
