import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquareTextIcon } from 'lucide-react'
import { useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/** Mirrors `systemPrompt` in src/workspace/config.ts. */
const GLOBAL_PROMPT_MAX = 20_000

/**
 * Settings → Global → Instructions: rules every task in every project reads. The project's own
 * system prompt is merged after them and wins where they conflict (`resolveExtraSystemPrompt`).
 */
export function GlobalInstructionsSection() {
  const config = useWorkspaceConfig()
  if (config.isPending) {
    return <p className="p-4 text-[13px] text-soft-foreground md:p-6">Loading instructions…</p>
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
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const [prompt, setPrompt] = useState(config.systemPrompt ?? '')
  const trimmed = prompt.trim()
  const saved = trimmed === (config.systemPrompt ?? '')
  const overLimit = trimmed.length > GLOBAL_PROMPT_MAX
  const savePrompt = () =>
    save.mutate(
      { systemPrompt: trimmed === '' ? null : trimmed },
      { onSuccess: () => toast(trimmed === '' ? 'Global instructions cleared' : 'Global instructions saved') },
    )

  return (
    <div
      data-slot="global-instructions-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField
        title="Global system prompt"
        hint="Read by every agent step of every new task, in every project. A project's own system prompt is added after it and takes precedence where they conflict."
      >
        <Textarea
          aria-label="Global system prompt"
          data-slot="global-instructions-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="General rules for every project — conventions, tone, review requirements…"
          className="min-h-32 max-w-xl"
        />
        <div className="flex max-w-xl items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="global-instructions-save"
            disabled={saved || overLimit || save.isPending}
            onClick={savePrompt}
          >
            Save
          </Button>
          {overLimit ? (
            <p data-slot="global-instructions-limit" className="text-[11px] text-danger">
              {trimmed.length.toLocaleString()} characters — the limit is {GLOBAL_PROMPT_MAX.toLocaleString()}.
            </p>
          ) : (
            <p className="text-[11px] text-soft-foreground">Leave empty and save to clear. Applied to new runs only.</p>
          )}
        </div>
      </SettingsField>
    </div>
  )
}
