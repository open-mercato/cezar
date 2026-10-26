import { MessageSquareTextIcon } from 'lucide-react'
import { useState } from 'react'

import { useConfig } from '@/api/queries'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { PromptTemplatesSection } from './prompt-templates-section'
import { SettingsField } from './settings-field'
import { useConfigSave } from './use-config-save'

/**
 * Settings → Instructions: everything the user WRITES for a model, in one place — the system
 * prompt (read by every agent step), the branch naming instructions (read by the namer when a
 * task starts) and the prompt templates (inserted into a composer by hand). Split out of Agents
 * because a textarea beside the runner picker read as "configure the agent", and the branch rule
 * kept being typed into the wrong box. Each hint names WHO reads the text and WHEN.
 *
 * Both textareas edit locally and save explicitly — a PUT on every keystroke would be a worse
 * control, not a simpler one.
 */

/** The server's caps (src/config.ts), enforced here too so an over-limit draft is a disabled
 *  Save with a reason, not a 400 round-trip. */
const SYSTEM_PROMPT_MAX = 20_000
const BRANCH_NAMING_MAX = 4_000

export function InstructionsSection() {
  const config = useConfig()

  if (config.isPending) {
    return (
      <p data-slot="instructions-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading instructions…
      </p>
    )
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
  return <InstructionsForm config={config.data} />
}

function InstructionsForm({ config }: { config: ConfigResponse }) {
  const save = useConfigSave()

  const [prompt, setPrompt] = useState(config.systemPrompt ?? '')
  const trimmedPrompt = prompt.trim()
  const promptSaved = trimmedPrompt === (config.systemPrompt ?? '')
  const promptOverLimit = trimmedPrompt.length > SYSTEM_PROMPT_MAX
  const savePrompt = () =>
    save.mutate(
      { systemPrompt: trimmedPrompt === '' ? null : trimmedPrompt },
      { onSuccess: () => toast(trimmedPrompt === '' ? 'System prompt cleared' : 'System prompt saved') },
    )

  const [branchNaming, setBranchNaming] = useState(config.branchNaming ?? '')
  const trimmedBranchNaming = branchNaming.trim()
  const branchNamingSaved = trimmedBranchNaming === (config.branchNaming ?? '')
  const branchNamingOverLimit = trimmedBranchNaming.length > BRANCH_NAMING_MAX
  const saveBranchNaming = () =>
    save.mutate(
      { branchNaming: trimmedBranchNaming === '' ? null : trimmedBranchNaming },
      { onSuccess: () => toast(trimmedBranchNaming === '' ? 'Branch naming cleared' : 'Branch naming saved') },
    )

  return (
    <div
      data-slot="instructions-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField
        title="System prompt"
        hint="Read by every agent step of every new task in this project, whichever runner executes it. Added after the global instructions (General settings → Instructions) and takes precedence over them."
      >
        <Textarea
          aria-label="System prompt"
          data-slot="instructions-system-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Extra rules for every agent run — conventions, tone, review requirements…"
          className="min-h-32 max-w-xl"
        />
        <div className="flex max-w-xl items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="instructions-save-prompt"
            disabled={promptSaved || promptOverLimit || save.isPending}
            onClick={savePrompt}
          >
            Save
          </Button>
          {promptOverLimit ? (
            <p data-slot="instructions-prompt-limit" className="text-[11px] text-danger">
              {trimmedPrompt.length.toLocaleString()} characters — the limit is {SYSTEM_PROMPT_MAX.toLocaleString()}.
            </p>
          ) : (
            <p className="text-[11px] text-soft-foreground">Leave empty and save to clear. Applied to new runs only.</p>
          )}
        </div>
      </SettingsField>

      <SettingsField
        title="Branch naming"
        hint="How new task branches are named. Generated from the first prompt."
      >
        <Textarea
          aria-label="Branch naming"
          data-slot="instructions-branch-naming"
          value={branchNaming}
          onChange={(event) => setBranchNaming(event.target.value)}
          placeholder="Describe your branch naming convention…"
          className="min-h-24 max-w-xl"
        />
        <div className="flex max-w-xl items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="instructions-save-branch-naming"
            disabled={branchNamingSaved || branchNamingOverLimit || save.isPending}
            onClick={saveBranchNaming}
          >
            Save
          </Button>
          {branchNamingOverLimit ? (
            <p data-slot="instructions-branch-naming-limit" className="text-[11px] text-danger">
              {trimmedBranchNaming.length.toLocaleString()} characters — the limit is{' '}
              {BRANCH_NAMING_MAX.toLocaleString()}.
            </p>
          ) : (
            <p className="text-[11px] text-soft-foreground">
              Leave empty for the default names. A new task waits for its name before it forks.
            </p>
          )}
        </div>
      </SettingsField>

      {/* Anchored so the composers' "Edit templates…" lands on the list, not the page top. */}
      <div id="prompt-templates" className="scroll-mt-20">
        <PromptTemplatesSection embedded />
      </div>
    </div>
  )
}
