import { EditorTrackerFields } from './editor-tracker-fields'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, FileTextIcon, LayoutTemplateIcon, Settings2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'
import { ApiError, createAutomation, updateAutomation } from '@/api/client'
import { useHealth, useRepo, useSkills, useUiState, useWorkflows } from '@/api/queries'
import { Chip } from '@/components/chip'
import { Pill } from '@/components/pill'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useNavigate } from '@/lib/project-router'
import { availablePromptTemplates, insertTemplate, normalizePromptTemplates } from '@/lib/prompt-templates'
import { orderSkillsByUsage } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { settingsSectionPath } from '@/routes/settings/settings-shell'

import { CopyAsCliCard } from './copy-as-cli-card'
import { EditorDispatchRow } from './editor-dispatch-row'
import {
  applyTemplate,
  cliDefinitionOf,
  fromDefinition,
  newDraft,
  pickSource,
  sourceOf,
  toBody,
  type EditorDraft,
} from './editor-draft'
import { EditorGithubFields } from './editor-github-fields'
import { EditorRunAs } from './editor-run-as'
import { EditorScheduleFields } from './editor-schedule-fields'
import { LastRunCard } from './last-run-card'
import { NextRunsPreview } from './next-runs-preview'
import { TemplatePalette } from './template-palette'
import { automationsQueryKey, type AutomationActions } from './use-automations'

/** Where a save error is shown: under the section it names, or above everything. */
type ErrorSection = 'top' | 'when' | 'what'

interface SaveError {
  message: string
  section: ErrorSection
}

function sectionOf(message: string): ErrorSection {
  const text = message.toLowerCase()
  if (/\b(events?|filters?|schedule|interval|changedlabels|changed labels|lookback|maxrecords)\b/.test(text)) return 'when'
  if (/\b(prompt|workflow|runner|model|dispatch)\b/.test(text)) return 'what'
  return 'top'
}

const PLACEHOLDER = {
  tracker: 'Implement {{tracker.key}} and prepare a pull request.',
  schedule: 'Describe the task the agent should do each time. Placeholders: {{date}}, {{project}}',
  github: 'Describe the task the agent should do for each match. Placeholders: {{github.url}}, {{github.title}}, {{github.number}}, {{github.labels}}',
} as const

/**
 * `/automations/new` and `/automations/:id` (spec 2026-09-14-automations-redesign § UI/UX 4).
 * One form for both kinds; the draft lives in `editor-draft.ts`, the sections in their own
 * files, and this component owns the header, the save and the two error paths — a stale
 * revision (409, "edited elsewhere") and a validation 400 shown under the section it names.
 */
export function AutomationEditor({ data, automation, actions, onBack, onSaved, onLog }: {
  data: AutomationsResponse | undefined
  automation?: AutomationListEntry
  actions?: AutomationActions
  onBack: () => void
  onSaved: () => void
  onLog?: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const health = useHealth()
  const uiState = useUiState()
  const workflows = useWorkflows()
  const skills = useSkills()
  const repo = useRepo()

  const [draft, setDraft] = useState<EditorDraft>(() => (automation ? fromDefinition(automation) : newDraft()))
  const [showTemplates, setShowTemplates] = useState(!automation)
  const [trackerValid, setTrackerValid] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<SaveError | null>(null)
  const [conflict, setConflict] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  // A reload after "edited elsewhere" (or any refetch that bumped the revision) re-reads the
  // form from the fresh definition — the stale draft is exactly what the 409 refused.
  const revision = automation?.revision
  const loadedRevision = useRef(revision)
  useEffect(() => {
    if (!automation || revision === loadedRevision.current) return
    loadedRevision.current = revision
    setDraft(fromDefinition(automation))
    setConflict(false)
    setError(null)
  }, [automation, revision])

  const patch = (next: Partial<EditorDraft>) => setDraft((current) => ({ ...current, ...next }))
  const timeZone = data?.timeZone ?? 'UTC'
  const githubAvailable = data?.available !== false
  const dispatchAvailable = health.data?.capabilities.dispatch === true
  const promptTemplates = useMemo(
    () => availablePromptTemplates(normalizePromptTemplates(uiState.data?.promptTemplates), health.data?.capabilities),
    [uiState.data?.promptTemplates, health.data?.capabilities],
  )
  const workflowList = workflows.data?.workflows ?? []
  const workflowNames = workflowList.map((workflow) => workflow.name)
  const skillsData = skills.data
  const skillUsage = uiState.data?.skillUsage
  const skillList = useMemo(() => orderSkillsByUsage(skillsData ?? [], skillUsage), [skillsData, skillUsage])
  const sourcesReady = skills.data !== undefined && workflows.data !== undefined && !uiState.isPending
  const baseBranch = repo.data?.baseBranch ?? repo.data?.info?.branch ?? undefined
  const cli = useMemo(() => cliDefinitionOf(draft), [draft])
  const canSave = draft.name.trim().length > 0 && draft.prompt.trim().length > 0 && !saving && (draft.kind !== 'tracker' || trackerValid)

  const insertPrompt = (snippet: string) => {
    const box = promptRef.current
    const caret = box?.selectionStart ?? draft.prompt.length
    const result = insertTemplate(draft.prompt, caret, snippet)
    patch({ prompt: result.text })
    requestAnimationFrame(() => {
      if (!box) return
      box.focus()
      box.setSelectionRange(result.caret, result.caret)
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      const body = toBody(draft)
      if (automation) {
        await updateAutomation(automation.id, { ...body, enabled: draft.enabled, expectedRevision: automation.revision })
      } else {
        await createAutomation({ ...body, enable: draft.enabled })
      }
      await queryClient.invalidateQueries({ queryKey: automationsQueryKey() })
      onSaved()
    } catch (caught) {
      if (automation && caught instanceof ApiError && caught.status === 409) {
        setConflict(true)
      } else {
        const message = caught instanceof Error ? caught.message : String(caught)
        setError({ message, section: caught instanceof ApiError && caught.status === 400 ? sectionOf(message) : 'top' })
      }
    } finally {
      setSaving(false)
    }
  }

  const reload = () => void queryClient.invalidateQueries({ queryKey: automationsQueryKey() })
  const saveLabel = automation ? 'Save changes' : draft.enabled ? 'Save and enable' : 'Save paused'


  return (
    <div data-route="automations" data-slot="automation-editor" className="flex min-h-full flex-col">
      {/* The kit's 56px header. Below `md` it may wrap onto a second row: a phone cannot fit the
          title, the template toggle and both actions on one line, and Save must stay reachable. */}
      <header className="sticky top-0 z-10 flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-5 max-md:py-2 md:h-14 md:flex-nowrap">
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" className="size-[15px]" />
        </Button>
        <h1 className="truncate text-base font-semibold">{automation ? 'Edit automation' : 'New automation'}</h1>
        {automation ? (
          <Pill dot={automation.enabled ? 'success' : 'neutral'}>{automation.enabled ? 'enabled' : 'paused'}</Pill>
        ) : null}
        <span className="flex-1" />
        {!automation ? (
          <Button variant="ghost" size="sm" aria-expanded={showTemplates} aria-label={showTemplates ? 'Hide templates' : 'Start from a template'} onClick={() => setShowTemplates((open) => !open)}>
            <LayoutTemplateIcon aria-hidden="true" className="size-3.5" />
            <span className="max-md:hidden">{showTemplates ? 'Hide templates' : 'Start from a template'}</span>
          </Button>
        ) : null}
        <Button variant="outline" onClick={onBack}>Cancel</Button>
        <Button disabled={!canSave} onClick={() => void save()}>{saveLabel}</Button>
      </header>

      <div className="flex justify-center p-5">
        <div className="grid w-full max-w-[1080px] grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-4">
            {conflict ? (
              <div role="alert" data-slot="editor-conflict" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[13px] text-foreground">
                Edited elsewhere — reload to see the latest version
                <Button variant="outline" size="sm" className="ml-auto" onClick={reload}>Reload</Button>
              </div>
            ) : null}
            {error?.section === 'top' ? <InlineAlert>{error.message}</InlineAlert> : null}

            {showTemplates && !automation ? (
              <TemplatePalette
                onPick={(template) => {
                  // A template from another project may name a workflow this repo does not
                  // have; only a workflow the cockpit lists survives, else the default applies.
                  const workflow = template.workflow && workflowNames.includes(template.workflow) ? template.workflow : undefined
                  setDraft((current) => applyTemplate(current, { ...template, workflow }))
                  setShowTemplates(false)
                }}
              />
            ) : null}

            <Section title="Name">
              <Input
                aria-label="Name"
                placeholder="Nightly dependency bump"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                className="max-w-[420px] text-[15px] md:text-[15px]"
              />
            </Section>

            <Section title="When">
              <KindSegment
                value={draft.kind}
                editing={!!automation}
                githubAvailable={githubAvailable}
                githubReason={data?.reason}
                onChange={(kind) => patch({ kind, ...(kind === 'tracker' ? { intervalSeconds: 1800, enabled: false } : {}) })}
              />
              {draft.kind === 'schedule' ? (
                <EditorScheduleFields schedule={draft.schedule} timeZone={timeZone} onChange={(schedule) => patch({ schedule })} />
              ) : draft.kind === 'tracker' ? (
                <EditorTrackerFields trigger={draft.trackerTrigger} intervalSeconds={draft.intervalSeconds} onChange={patch} onValid={setTrackerValid} />
              ) : (
                <EditorGithubFields
                  events={draft.events}
                  intervalSeconds={draft.intervalSeconds}
                  filters={draft.filters}
                  onChange={(next) => patch(next)}
                />
              )}
              {error?.section === 'when' ? <InlineAlert>{error.message}</InlineAlert> : null}
            </Section>

            <Section title="What to run">
              <div data-slot="editor-prompt-templates" className="flex flex-wrap items-center gap-1.5 text-xs text-soft-foreground">
                <FileTextIcon aria-hidden="true" className="size-3" />
                Prompt templates
                {promptTemplates.map((template) => (
                  <Chip key={template.id} className="h-6 text-[11.5px]" title={template.text} onClick={() => insertPrompt(template.text)}>
                    {template.label}
                  </Chip>
                ))}
                <Chip
                  dashed
                  className="h-6 text-[11.5px]"
                  icon={<Settings2Icon aria-hidden="true" className="size-3" />}
                  onClick={() => navigate(settingsSectionPath('project', 'prompt-templates'))}
                >
                  Manage…
                </Chip>
              </div>
              <Textarea
                ref={promptRef}
                aria-label="Prompt"
                rows={5}
                placeholder={PLACEHOLDER[draft.kind]}
                value={draft.prompt}
                onChange={(event) => patch({ prompt: event.target.value })}
                className="min-h-[104px] text-sm leading-[1.55] md:text-sm"
              />
              <EditorRunAs
                source={sourceOf(draft)}
                sourcesReady={sourcesReady}
                skills={skillList}
                skillUsage={skillUsage}
                workflows={workflowList}
                onSource={(source) => patch(pickSource(source))}
                pick={{ runner: draft.runner, model: draft.model, account: draft.account }}
                onPick={(pick) => patch({ runner: pick.runner, model: pick.model, account: pick.account })}
                baseBranch={baseBranch}
                autonomous={draft.autonomous}
                onAutonomous={(autonomous) => patch({ autonomous })}
              />
              <p className="m-0 text-xs leading-[1.5] text-soft-foreground">
                Each run is an ordinary cezar task in its own worktree — it queues behind the parallel cap like anything else and never auto-merges.
              </p>
              <EditorDispatchRow
                available={dispatchAvailable}
                enabled={draft.dispatch}
                maxSubtasks={draft.maxSubtasks}
                reviewChild={draft.reviewChild}
                onChange={(next) => patch(next)}
              />
              {error?.section === 'what' ? <InlineAlert>{error.message}</InlineAlert> : null}
            </Section>

            <Section title="Enable">
              <Label className="text-[13px] font-medium">
                <Switch aria-label="Enabled" checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
                Enabled
                {draft.kind !== 'schedule' ? (
                  <span className="text-xs font-normal text-muted-foreground">— from a current-time baseline; existing matches will not launch</span>
                ) : null}
              </Label>
            </Section>
          </div>

          <div className="flex flex-col gap-3 lg:sticky lg:top-[76px]">
            <NextRunsPreview kind={draft.kind} schedule={draft.schedule} intervalSeconds={draft.intervalSeconds} timeZone={timeZone} />
            <CopyAsCliCard definition={cli} />
            {automation && automation.kind !== 'schedule' && actions ? <Button variant="outline" disabled={actions.busy} onClick={() => void actions.preview(automation)}>Preview saved matches</Button> : null}
            {automation?.lastRun ? (
              <LastRunCard
                lastRun={automation.lastRun}
                busy={actions?.busy}
                onRunNow={() => void actions?.runNow(automation)}
                onLog={onLog}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** `Card` `padding 0 24px`, title 600 14px `16px 0 4px`, body column gap 14 `10px 0 20px`. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card data-slot="editor-section" className="gap-0 px-6 py-0">
      <div className="pt-4 pb-1 text-sm font-semibold">{title}</div>
      <div className="flex flex-col gap-3.5 pt-2.5 pb-5">{children}</div>
    </Card>
  )
}

function InlineAlert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {children}
    </p>
  )
}

/**
 * The When section's kind switch — `Segmented`'s grammar with what it lacks: a per-option
 * `disabled` carrying its reason. GitHub is out when the forge is (`data.reason`), and on an
 * existing automation the OTHER kind is out too: the server answers a kind switch with 409
 * (receipts and cursors are kind-specific), so the editor says so before the round trip.
 */
function KindSegment({ value, editing, githubAvailable, githubReason, onChange }: {
  value: 'schedule' | 'github' | 'tracker'
  editing: boolean
  githubAvailable: boolean
  githubReason: string | undefined
  onChange: (kind: 'schedule' | 'github' | 'tracker') => void
}) {
  const kindLocked = 'Change the kind by creating a new automation'
  const options: ReadonlyArray<{ value: 'schedule' | 'github' | 'tracker'; label: string; disabled: boolean; title?: string }> = [
    {
      value: 'schedule',
      label: 'On a schedule',
      disabled: editing && value !== 'schedule',
      ...(editing && value !== 'schedule' ? { title: kindLocked } : {}),
    },
    {
      value: 'github',
      label: 'When GitHub changes',
      disabled: !githubAvailable || (editing && value !== 'github'),
      ...(!githubAvailable
        ? { title: githubReason ?? 'GitHub is unavailable' }
        : editing && value !== 'github'
          ? { title: kindLocked }
          : {}),
    },
    { value: 'tracker', label: 'When Jira / Linear changes', disabled: editing && value !== 'tracker', ...(editing && value !== 'tracker' ? { title: kindLocked } : {}) },
  ]
  return (
    <div data-slot="editor-kind" role="group" aria-label="Trigger" className="inline-flex flex-wrap gap-0.5 self-start rounded-md bg-muted p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-value={option.value}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => { if (option.value !== value) onChange(option.value) }}
          className={cn(
            'flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50',
            option.value === value && 'bg-card font-semibold text-foreground shadow-xs',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
