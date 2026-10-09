import { EditorTrackerFields } from './editor-tracker-fields'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, LayoutTemplateIcon, Settings2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'
import { ApiError, createAutomation, updateAutomation } from '@/api/client'
import { useHealth, useRepo, useSkills, useUiState, useWorkflows } from '@/api/queries'
import { Chip } from '@/components/chip'
import { Page, PageBody, PageHeader, PageRow, PageSection } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import { useNavigate } from '@/lib/project-router'
import { availablePromptTemplates, insertTemplate, normalizePromptTemplates } from '@/lib/prompt-templates'
import { orderSkillsByUsage } from '@/lib/skills'
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
    <Page data-route="automations" data-slot="automation-editor">
      <PageHeader
        eyebrow={
          <Button variant="ghost" size="xs" className="-ml-2 font-normal" aria-label="Back" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" />
            Automations
          </Button>
        }
        title={
          <span className="flex items-center gap-3">
            <span className="truncate">{automation ? 'Edit automation' : 'New automation'}</span>
            {automation ? (
              <Badge variant="outline" className="gap-1.5 font-normal">
                <StatusDot tone={automation.enabled ? 'success' : 'neutral'} />
                {automation.enabled ? 'Enabled' : 'Paused'}
              </Badge>
            ) : null}
          </span>
        }
        description={automation ? automation.name : 'Describe the task, then choose when it runs. Save it paused to try it first.'}
        actions={
          !automation ? (
            <Button variant="outline" aria-expanded={showTemplates} aria-label={showTemplates ? 'Hide templates' : 'Start from a template'} onClick={() => setShowTemplates((open) => !open)}>
              <LayoutTemplateIcon aria-hidden="true" />
              <span className="max-md:hidden">{showTemplates ? 'Hide templates' : 'Start from a template'}</span>
            </Button>
          ) : undefined
        }
      />

      <PageBody className="grid grid-cols-1 items-start gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col">
          {conflict ? (
            <Alert variant="destructive" data-slot="editor-conflict" className="mb-6">
              <AlertTitle>Edited elsewhere — reload to see the latest version</AlertTitle>
              <AlertDescription>
                <Button variant="outline" size="sm" className="mt-1" onClick={reload}>Reload</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {error?.section === 'top' ? <div className="mb-6"><InlineAlert>{error.message}</InlineAlert></div> : null}

          {showTemplates && !automation ? (
            <div className="mb-8">
              <TemplatePalette
                onPick={(template) => {
                  // A template from another project may name a workflow this repo does not
                  // have; only a workflow the cockpit lists survives, else the default applies.
                  const workflow = template.workflow && workflowNames.includes(template.workflow) ? template.workflow : undefined
                  setDraft((current) => applyTemplate(current, { ...template, workflow }))
                  setShowTemplates(false)
                }}
              />
            </div>
          ) : null}

          <Section title="What to run" description="Each run is an ordinary cezar task in its own worktree — it queues behind the parallel cap like anything else and never auto-merges.">
            <Field>
              <FieldLabel htmlFor="automation-name">Name</FieldLabel>
              <Input
                id="automation-name"
                aria-label="Name"
                placeholder="Nightly dependency bump"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                className="max-w-[420px]"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="automation-prompt">Prompt</FieldLabel>
              <Textarea
                id="automation-prompt"
                ref={promptRef}
                aria-label="Prompt"
                rows={5}
                placeholder={PLACEHOLDER[draft.kind]}
                value={draft.prompt}
                onChange={(event) => patch({ prompt: event.target.value })}
                className="min-h-[120px] text-sm leading-relaxed md:text-sm"
              />
              <div data-slot="editor-prompt-templates" className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="mr-0.5">Insert a template</span>
                {promptTemplates.map((template) => (
                  <Chip key={template.id} className="h-6 text-xs" title={template.text} onClick={() => insertPrompt(template.text)}>
                    {template.label}
                  </Chip>
                ))}
                <Chip
                  dashed
                  className="h-6 text-xs"
                  icon={<Settings2Icon aria-hidden="true" className="size-3" />}
                  onClick={() => navigate(settingsSectionPath('project', 'prompt-templates'))}
                >
                  Manage…
                </Chip>
              </div>
            </Field>
            <Field>
              <FieldLabel>Runs as</FieldLabel>
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
              />
            </Field>
            {error?.section === 'what' ? <InlineAlert>{error.message}</InlineAlert> : null}
          </Section>

          <Section title="When" description="What starts a run.">
            <KindSegment
              value={draft.kind}
              editing={!!automation}
              githubAvailable={githubAvailable}
              githubReason={data?.reason}
              onChange={(kind) => patch({ kind, ...(kind === 'tracker' ? { intervalSeconds: 1800, enabled: false } : {}) })}
            />
            {draft.kind === 'schedule' ? (
              <EditorScheduleFields schedule={draft.schedule} timeZone={timeZone} onChange={(schedule) => patch({ schedule })} />
            ) : null}
            {draft.kind === 'schedule' && error?.section === 'when' ? <InlineAlert>{error.message}</InlineAlert> : null}
          </Section>

          {draft.kind === 'github' ? (
            <Section title="GitHub trigger" description="The events to watch, how often to check, and which issues or pull requests count.">
              <EditorGithubFields
                events={draft.events}
                intervalSeconds={draft.intervalSeconds}
                filters={draft.filters}
                onChange={(next) => patch(next)}
              />
              {error?.section === 'when' ? <InlineAlert>{error.message}</InlineAlert> : null}
            </Section>
          ) : draft.kind === 'tracker' ? (
            <Section title="Tracker trigger" description="The Jira or Linear events to watch in this project's tracker.">
              <EditorTrackerFields trigger={draft.trackerTrigger} intervalSeconds={draft.intervalSeconds} onChange={patch} onValid={setTrackerValid} />
              {error?.section === 'when' ? <InlineAlert>{error.message}</InlineAlert> : null}
            </Section>
          ) : null}

          <Section title="Advanced" description="How much the run may do on its own.">
            <Field orientation="horizontal" className="items-start justify-between gap-6">
              <div className="min-w-0 space-y-1">
                <FieldLabel htmlFor="automation-autonomous">Autonomous</FieldLabel>
                <FieldDescription>Keep working through the workflow without waiting for a person between turns.</FieldDescription>
              </div>
              <Switch id="automation-autonomous" aria-label="Autonomous" checked={draft.autonomous} onCheckedChange={(autonomous) => patch({ autonomous })} />
            </Field>
            <EditorDispatchRow
              available={dispatchAvailable}
              enabled={draft.dispatch}
              maxSubtasks={draft.maxSubtasks}
              reviewChild={draft.reviewChild}
              onChange={(next) => patch(next)}
            />
          </Section>
        </div>

        <aside className="flex flex-col gap-8 lg:sticky lg:top-6">
          <NextRunsPreview kind={draft.kind} schedule={draft.schedule} intervalSeconds={draft.intervalSeconds} timeZone={timeZone} />
          {automation?.lastRun ? (
            <LastRunCard
              lastRun={automation.lastRun}
              busy={actions?.busy}
              onRunNow={() => void actions?.runNow(automation)}
              onLog={onLog}
            />
          ) : null}
          {automation && automation.kind !== 'schedule' && actions ? <Button variant="outline" className="self-start" disabled={actions.busy} onClick={() => void actions.preview(automation)}>Preview saved matches</Button> : null}
          <CopyAsCliCard definition={cli} />
        </aside>
      </PageBody>

      {/* The sticky footer: the enable switch and the two ways out, always in reach. */}
      <div data-slot="editor-footer" className="sticky bottom-0 z-10 mt-auto border-t border-border bg-background/95 backdrop-blur">
        <PageRow className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <Label className="min-w-0 text-[13px] font-medium">
            <Switch aria-label="Enabled" checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
            Enabled
            {draft.kind !== 'schedule' ? (
              <span className="truncate text-xs font-normal text-muted-foreground max-md:hidden">— from a current-time baseline; existing matches will not launch</span>
            ) : null}
          </Label>
          <span className="flex-1" />
          <Button variant="outline" onClick={onBack}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>{saveLabel}</Button>
        </PageRow>
      </div>
    </Page>
  )
}

/** One titled group of the form — separated from the previous one by a rule and space, not a box. */
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div data-slot="editor-section" className="not-first:mt-8 not-first:border-t not-first:border-border/70 not-first:pt-8">
      <PageSection title={title} description={description}>
        <div className="flex flex-col gap-5 pt-2">{children}</div>
      </PageSection>
    </div>
  )
}

function InlineAlert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">
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
        <Toggle
          key={option.value}
          data-value={option.value}
          pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onPressedChange={() => { if (option.value !== value) onChange(option.value) }}
          className="h-8 min-w-0 gap-1.5 rounded-sm px-3 text-[13px] text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-xs"
        >
          {option.label}
        </Toggle>
      ))}
    </div>
  )
}
