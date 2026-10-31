import { EditorTrackerFields } from './editor-tracker-fields'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, FileTextIcon, LayoutTemplateIcon, Settings2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'
import { ApiError, createAutomation, updateAutomation } from '@/api/client'
import { useHealth, useRepo, useSkills, useUiState, useWorkflows } from '@/api/queries'
import { Chip } from '@/components/chip'
import { GithubIcon } from '@/components/icons'
import { OnboardingStepRail, SelectTile } from '@/components/onboarding-kit'
import { Pill } from '@/components/pill'
import { Button } from '@/components/ui/button'
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
  splitList,
  toBody,
  unenforcedPromptLogins,
  type EditorDraft,
} from './editor-draft'
import { EditorGithubFields } from './editor-github-fields'
import { EditorRunAs } from './editor-run-as'
import { EditorScheduleFields } from './editor-schedule-fields'
import { PLACEHOLDERS, draftSentence, railSteps } from './editor-sentence'
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
  schedule: 'What should the agent do each time? Say it the way you would in New task.',
  github: 'What should the agent do for each match? Say it the way you would in New task.',
} as const

/**
 * `/automations/new` and `/automations/:id` (spec 2026-09-14-automations-redesign § UI/UX 4, in
 * the onboarding grammar since spec 2026-10-26-first-run-onboarding § Automations editor). One
 * centred column that reads top to bottom as a sentence — When, What, Go live — with a rail that
 * ticks as the form fills in and a readback line that says what will happen. The draft lives in
 * `editor-draft.ts`, the sections in their own files, and this component owns the header, the
 * save and the two error paths — a stale revision (409, "edited elsewhere") and a validation 400
 * shown under the section it names.
 */
export function AutomationEditor({ data, automation, actions, initialKind, onBack, onSaved, onLog }: {
  data: AutomationsResponse | undefined
  automation?: AutomationListEntry
  actions?: AutomationActions
  /** A new automation opened on this trigger (the explainer's tiles); the template palette stays closed. */
  initialKind?: 'schedule' | 'github' | 'tracker'
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

  // A GitHub tile with the forge known unavailable falls back to a schedule: the kind switch
  // would show it disabled, and nothing could be saved under it.
  const startKind = initialKind === 'github' && data?.available === false ? 'schedule' : initialKind
  const [draft, setDraft] = useState<EditorDraft>(() =>
    automation
      ? fromDefinition(automation)
      : startKind
        ? { ...newDraft(), kind: startKind, ...(startKind === 'tracker' ? { intervalSeconds: 1800, enabled: false } : {}) }
        : newDraft(),
  )
  const [showTemplates, setShowTemplates] = useState(!automation && !startKind)
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
  const skillNames = (skillsData ?? []).map((skill) => skill.name)
  const skillUsage = uiState.data?.skillUsage
  const skillList = useMemo(() => orderSkillsByUsage(skillsData ?? [], skillUsage), [skillsData, skillUsage])
  const sourcesReady = skills.data !== undefined && workflows.data !== undefined && !uiState.isPending
  const baseBranch = repo.data?.baseBranch ?? repo.data?.info?.branch ?? undefined
  const cli = useMemo(() => cliDefinitionOf(draft), [draft])
  const unenforcedLogins = useMemo(() => unenforcedPromptLogins(draft), [draft])
  const loginsFor = (field: 'authors' | 'reviewers') => unenforcedLogins.filter((entry) => entry.field === field).map((entry) => entry.login)
  const canSave = draft.name.trim().length > 0 && draft.prompt.trim().length > 0 && !saving && (draft.kind !== 'tracker' || trackerValid)
  const rail = railSteps(draft, trackerValid)
  const sentence = draftSentence(draft, dispatchAvailable)

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
  /** A placeholder goes in at the caret as a word, with a space on whichever side needs one. */
  const insertPlaceholder = (token: string) => {
    const box = promptRef.current
    const caret = box?.selectionStart ?? draft.prompt.length
    const before = draft.prompt.slice(0, caret)
    const after = draft.prompt.slice(caret)
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
    const text = `${before}${lead}${token}${trail}${after}`
    const at = before.length + lead.length + token.length
    patch({ prompt: text })
    requestAnimationFrame(() => {
      if (!box) return
      box.focus()
      box.setSelectionRange(at, at)
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
  const kindLocked = 'Change the kind by creating a new automation'
  const editing = !!automation
  const setKind = (kind: EditorDraft['kind']) => {
    if (kind !== draft.kind) patch({ kind, ...(kind === 'tracker' ? { intervalSeconds: 1800, enabled: false } : {}) })
  }

  return (
    <div data-route="automations" data-slot="automation-editor" data-onboarding="" className="flex min-h-full flex-col">
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
        <Button variant="outline" className="font-normal" onClick={onBack}>Cancel</Button>
        <Button className="font-normal" disabled={!canSave} onClick={() => void save()}>{saveLabel}</Button>
      </header>

      <div className="flex justify-center px-5 pb-16">
        <div className="flex w-full max-w-3xl flex-col items-center">
          {/* One low strip — the name and the rail — that stays under the header while the form
              scrolls, so what you are building and how far along you are never leave the screen.
              Static below `md`, where the header may wrap and a sticky strip would cover the form. */}
          <div
            data-slot="editor-strip"
            className="sticky top-14 z-10 flex w-full flex-wrap items-center gap-x-6 gap-y-1.5 border-b border-border bg-background/95 py-2.5 backdrop-blur max-md:static"
          >
            {/* A plain form field, not a heading that happens to be editable: a borderless line
                read as a title, and nobody typed into it. */}
            <div className="flex min-w-0 flex-1 items-center gap-3 max-md:basis-full">
              <span className="shrink-0 text-ui text-muted-foreground" aria-hidden="true">Name</span>
              <Input
                aria-label="Name"
                placeholder="Nightly dependency bump"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                className="h-9 w-full max-w-md text-lead md:text-lead"
              />
            </div>
            <OnboardingStepRail steps={rail} />
          </div>

          {conflict || error?.section === 'top' || (showTemplates && !automation) ? (
          <div className="mt-6 flex w-full flex-col gap-4">
            {conflict ? (
              <div role="alert" data-slot="editor-conflict" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-ui text-foreground">
                Edited elsewhere — reload to see the latest version
                <Button variant="outline" size="sm" className="ml-auto" onClick={reload}>Reload</Button>
              </div>
            ) : null}
            {error?.section === 'top' ? <InlineAlert>{error.message}</InlineAlert> : null}

            {showTemplates && !automation ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 text-center text-ui text-muted-foreground">Start from a template, or fill in the three parts below.</p>
                <TemplatePalette
                  onPick={(template) => {
                    // A template from another project may name a workflow or skill this repo does
                    // not have; only what the cockpit lists survives, else the default applies.
                    const workflow = template.workflow && workflowNames.includes(template.workflow) ? template.workflow : undefined
                    const steps = template.steps?.every((step) => !step.skill || skillNames.includes(step.skill)) ? template.steps : undefined
                    setDraft((current) => applyTemplate(current, { ...template, workflow, steps }))
                    setShowTemplates(false)
                  }}
                />
              </div>
            ) : null}
          </div>
          ) : null}

          <Section
            slot="when"
            title="When"
            why={editing ? 'The trigger is fixed once saved; change it by creating a new automation.' : 'What starts a run. Pick one, then say how often or on which change.'}
          >
            <div data-slot="editor-kind" role="group" aria-label="Trigger" className="grid gap-3 sm:grid-cols-3">
              <SelectTile
                value="schedule"
                title="On a schedule"
                description="At a time you set."
                selected={draft.kind === 'schedule'}
                disabled={editing && draft.kind !== 'schedule'}
                reason={editing && draft.kind !== 'schedule' ? kindLocked : undefined}
                onClick={() => setKind('schedule')}
                picture={<SchedulePicture />}
              />
              <SelectTile
                value="github"
                title="When GitHub changes"
                description="A pull request, an issue, a review."
                selected={draft.kind === 'github'}
                disabled={!githubAvailable || (editing && draft.kind !== 'github')}
                reason={!githubAvailable ? (data?.reason ?? 'GitHub is unavailable') : editing && draft.kind !== 'github' ? kindLocked : undefined}
                onClick={() => setKind('github')}
                picture={<GithubIcon className="size-7 text-muted-foreground" aria-hidden={true} />}
              />
              <SelectTile
                value="tracker"
                title="When Jira / Linear changes"
                description="An issue is created or moves."
                selected={draft.kind === 'tracker'}
                disabled={editing && draft.kind !== 'tracker'}
                reason={editing && draft.kind !== 'tracker' ? kindLocked : undefined}
                onClick={() => setKind('tracker')}
                picture={<TrackerPicture />}
              />
            </div>
            <div className="mt-5">
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
            </div>
            {/* A poll already says how it polls in its own sentence; the schedule's next runs are the preview worth a card. */}
            {draft.kind === 'schedule' ? (
              <div className="mt-5">
                <NextRunsPreview kind={draft.kind} schedule={draft.schedule} intervalSeconds={draft.intervalSeconds} timeZone={timeZone} />
              </div>
            ) : null}
            {error?.section === 'when' ? <InlineAlert>{error.message}</InlineAlert> : null}
          </Section>

          <Section slot="what" title="What the agent does" why="The same words you would type into New task. Placeholders fill in per run.">
            <div data-slot="editor-placeholders" className="flex flex-wrap items-center gap-1.5 text-xs text-soft-foreground">
              Insert
              {PLACEHOLDERS[draft.kind].map((token) => (
                <Chip key={token} className="h-6 font-mono text-meta" title={`Insert ${token} at the caret`} onClick={() => insertPlaceholder(token)}>
                  {token}
                </Chip>
              ))}
            </div>
            <Textarea
              ref={promptRef}
              aria-label="Prompt"
              rows={5}
              placeholder={PLACEHOLDER[draft.kind]}
              value={draft.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
              className="mt-3 min-h-[120px] rounded-xl px-4 py-3 text-lead leading-[1.55] md:text-lead"
            />
            <div data-slot="editor-prompt-templates" className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-soft-foreground">
              <FileTextIcon aria-hidden="true" className="size-3" />
              Prompt templates
              {promptTemplates.map((template) => (
                <Chip key={template.id} className="h-6 text-meta" title={template.text} onClick={() => insertPrompt(template.text)}>
                  {template.label}
                </Chip>
              ))}
              <Chip
                dashed
                className="h-6 text-meta"
                icon={<Settings2Icon aria-hidden="true" className="size-3" />}
                onClick={() => navigate(`${settingsSectionPath('project', 'instructions')}#prompt-templates`)}
              >
                Manage…
              </Chip>
            </div>
            {unenforcedLogins.length > 0 ? (
              <div role="status" data-slot="editor-prompt-condition" className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-label text-foreground">
                <span className="min-w-0 flex-1">
                  The prompt names {unenforcedLogins.map(({ login }) => `@${login}`).join(', ')}, but prompt text does not decide what launches — without a filter every matching event starts a task.
                </span>
                {(['authors', 'reviewers'] as const).map((field) =>
                  loginsFor(field).length > 0 ? (
                    <Button
                      key={field}
                      variant="outline"
                      size="sm"
                      onClick={() => patch({ filters: { ...draft.filters, [field]: [...splitList(draft.filters[field]), ...loginsFor(field)].join(', ') } })}
                    >
                      {field === 'authors' ? 'Add to Authors' : 'Add to Reviewers'}
                    </Button>
                  ) : null,
                )}
              </div>
            ) : null}
            <div className="mt-5">
              <EditorRunAs
                source={sourceOf(draft)}
                sourcesReady={sourcesReady}
                skills={skillList}
                skillUsage={skillUsage}
                workflows={workflowList}
                onSource={(source) => patch(pickSource(source))}
                pick={{ runner: draft.runner, model: draft.model, reasoningEffort: draft.reasoningEffort, account: draft.account }}
                onPick={(pick) => patch({ runner: pick.runner, model: pick.model, reasoningEffort: pick.reasoningEffort ?? null, account: pick.account })}
                baseBranch={baseBranch}
                autonomous={draft.autonomous}
                onAutonomous={(autonomous) => patch({ autonomous })}
              />
            </div>
            <p className="mt-3 mb-0 text-xs leading-[1.5] text-soft-foreground">
              Each run is an ordinary cezar task in its own worktree — it queues behind the parallel cap like anything else and never auto-merges.
            </p>
            <div className="mt-3">
              <EditorDispatchRow
                available={dispatchAvailable}
                enabled={draft.dispatch}
                maxSubtasks={draft.maxSubtasks}
                reviewChild={draft.reviewChild}
                onChange={(next) => patch(next)}
              />
            </div>
            {error?.section === 'what' ? <InlineAlert>{error.message}</InlineAlert> : null}
          </Section>

          <Section slot="live" title="Go live" why="Paused, it waits in the list where you can preview it. Enabled, it starts counting from now.">
            <p data-slot="editor-summary" className="m-0 rounded-xl border border-violet/40 bg-violet/10 px-4 py-3 text-body text-foreground">
              {sentence}
            </p>
            <Label className="mt-4 flex items-start gap-3 text-ui font-normal">
              <Switch aria-label="Enabled" checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-body text-foreground">Enabled</span>
                <span className="text-label text-muted-foreground">
                  {draft.kind !== 'schedule'
                    ? 'Counts from a current-time baseline; existing matches will not launch.'
                    : draft.enabled
                      ? 'Runs at the next time listed above.'
                      : 'Saved paused. Enable it from the list, or Run now to try it once.'}
                </span>
              </span>
            </Label>
            <div className="mt-6 flex flex-col gap-3">
              <CopyAsCliCard definition={cli} />
              {automation && automation.kind !== 'schedule' && actions ? (
                <Button variant="outline" className="self-start font-normal" disabled={actions.busy} onClick={() => void actions.preview(automation)}>
                  Preview saved matches
                </Button>
              ) : null}
              {automation?.lastRun ? (
                <LastRunCard
                  lastRun={automation.lastRun}
                  busy={actions?.busy}
                  onRunNow={() => void actions?.runNow(automation)}
                  onLog={onLog}
                />
              ) : null}
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}

/** One part of the sentence: a light title, one line on why, the controls — split by hairlines. */
function Section({ slot, title, why, children }: { slot: string; title: string; why: string; children: ReactNode }) {
  return (
    <section data-slot="editor-section" data-section={slot} className="mt-7 w-full border-t border-border pt-6 first-of-type:mt-6 first-of-type:border-t-0 first-of-type:pt-0">
      <h2 className="text-xl font-light tracking-tight text-foreground">{title}</h2>
      <p className="mt-1 mb-5 text-ui text-muted-foreground">{why}</p>
      {children}
    </section>
  )
}

function InlineAlert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={cn('mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-ui text-foreground')}>
      {children}
    </div>
  )
}

function SchedulePicture() {
  return (
    <span className="flex w-12 flex-col gap-1">
      <span className="flex items-center justify-between rounded-md border border-violet bg-violet/15 px-1 py-0.5 font-mono text-[7px] text-foreground">
        09:00<span className="size-1 rounded-full bg-violet" />
      </span>
      <span className="flex items-center justify-between rounded-md border border-border px-1 py-0.5 font-mono text-[7px] text-muted-foreground">
        16:00<span className="size-1 rounded-full bg-muted-foreground/50" />
      </span>
    </span>
  )
}

function TrackerPicture() {
  return (
    <span className="flex items-center gap-1 font-mono text-[7px]">
      <span className="rounded border border-border px-1 py-0.5 text-muted-foreground">To do</span>
      <span className="h-px w-1.5 bg-violet" />
      <span className="rounded border border-violet bg-violet/15 px-1 py-0.5 text-foreground">Ready</span>
    </span>
  )
}
