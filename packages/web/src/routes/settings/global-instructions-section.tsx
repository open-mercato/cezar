import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquareTextIcon } from 'lucide-react'
import { useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { FormRow, SettingsCard, isCommitKey, useSavedFlash } from './form-row'

/** Mirrors `systemPrompt` in src/workspace/config.ts. */
const GLOBAL_PROMPT_MAX = 20_000

/**
 * Settings → Agents → Global instructions: rules every task in every project reads. The
 * project's own system prompt is merged after them and wins where they conflict
 * (`resolveExtraSystemPrompt`). Saves on blur or ⌘↵ — the one text-field save model.
 */
export function GlobalInstructionsCard() {
  const config = useWorkspaceConfig()
  if (config.isPending) {
    return <LoadingState label="Loading instructions…"><SettingsSkeleton /></LoadingState>
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<MessageSquareTextIcon />}
        tone="danger"
        title="Instructions did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <GlobalInstructionsForm config={config.data} />
}

function GlobalInstructionsForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const [saved, flash] = useSavedFlash()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const stored = config.systemPrompt ?? ''
  const [prompt, setPrompt] = useState(stored)
  // Another tab's save landing: follow it unless this field holds an unsaved edit.
  const [lastStored, setLastStored] = useState(stored)
  if (stored !== lastStored) {
    setLastStored(stored)
    if (prompt.trim() === lastStored) setPrompt(stored)
  }
  const trimmed = prompt.trim()
  const unchanged = trimmed === stored
  const overLimit = trimmed.length > GLOBAL_PROMPT_MAX
  const commit = () => {
    if (unchanged || overLimit || save.isPending) return
    save.mutate({ systemPrompt: trimmed === '' ? null : trimmed })
  }

  return (
    <SettingsCard slot="global-instructions-section" title="Global instructions">
      <FormRow
        stacked
        saved={saved}
        htmlFor="global-instructions-prompt"
        label="System prompt for every task"
        description="Read by every agent step of every new task, in every project. A project's own system prompt is added after it and takes precedence where they conflict. Saves when you leave the field or press ⌘↵; leave it empty to clear."
      >
        <Textarea
          id="global-instructions-prompt"
          data-slot="global-instructions-prompt"
          value={prompt}
          aria-invalid={overLimit || undefined}
          onChange={(event) => setPrompt(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (isCommitKey(event, true)) {
              event.preventDefault()
              commit()
            }
          }}
          placeholder="General rules for every project — conventions, tone, review requirements…"
          className="min-h-32"
        />
        {overLimit ? (
          <p data-slot="global-instructions-limit" className="text-meta text-danger">
            {trimmed.length.toLocaleString()} characters — the limit is {GLOBAL_PROMPT_MAX.toLocaleString()}.
          </p>
        ) : null}
      </FormRow>
    </SettingsCard>
  )
}
