import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GripVerticalIcon,
  PlusIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
  WandSparklesIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError, createWorkflow, deleteWorkflow, parseWorkflow, postPlan } from '@/api/client'
import { queryKeys, useSkills, useUiState, useWorkflows } from '@/api/queries'
import type { Skill, WorkflowDef, WorkflowStepDef } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { SkillEmptyHintCompact } from '@/components/skill-empty-hint'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { isProjectSkill, orderSkillsByUsage } from '@/lib/skills'
import { cn } from '@/lib/utils'
import {
  WB_MAX_STEPS,
  draftFromPlan,
  insertStep,
  moveStep,
  removeStep,
  saveBody,
  skillStep,
  stepCountLabel,
  workflowSlug,
  workflowYaml,
} from '@/lib/workflow-builder'

import { WorkflowsLoading } from './workflows-loading'

/**
 * `/workflows` — the workflow builder rebuilt in React (R6 Step 1.6, spec §"Skills, Workflows,
 * Inbox"): same capabilities as the legacy tab (spec 012 — canvas, drag from palette, YAML
 * import/export/preview, the server's 8-step limit), visual language rebuilt on dnd-kit +
 * shadcn. No new behavior on purpose.
 *
 * Functional parity with `web/app.js`:
 *  - first visit seeds the canvas with the repo's first saved (file) workflow; `/workflows/:name`
 *    deep-links any workflow into the canvas;
 *  - palette skills COPY in (drag, or the keyboard/click "add" affordance); step cards MOVE;
 *  - a pure skill stack previews/saves in the portable compact `skills:` YAML form, anything
 *    richer in full `steps:` (lib/workflow-builder mirrors the server's `skillStackOf`);
 *  - Import → `POST /api/workflows/parse` (the server owns YAML), Save → `POST /api/workflows`
 *    with the 409-overwrite confirm, Delete → `DELETE /api/workflows/:name` (file workflows
 *    only), Export → a `<slug>.yaml` download, Copy → clipboard;
 *  - the 8-step limit answers a toast, exactly where the legacy `alertBar` fired.
 *
 * Drag is dnd-kit throughout: PointerSensor with a small activation distance (so plain clicks
 * on the cards' buttons stay clicks) + KeyboardSensor with the sortable coordinate getter —
 * keyboard-accessible reorder per dnd-kit defaults (focus a grip, Space lifts, arrows move,
 * Space drops).
 */

/** The canvas droppable's id — palette drops on it (not on a card) append at the end. */
const CANVAS_ID = 'wb-canvas'

type Draft = {
  name: string
  description: string
  steps: WorkflowStepDef[]
}

type DragItem = { type: 'palette'; skill: string } | { type: 'step'; step: WorkflowStepDef }

function emptyDraft(): Draft {
  return { name: 'my-workflow', description: '', steps: [] }
}

function draftFrom(workflow: WorkflowDef): Draft {
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    steps: structuredClone(workflow.steps ?? []),
  }
}

export function WorkflowsRoute() {
  const { name } = useParams<{ name: string }>()
  // Key the builder by the deep-linked name: navigating between /workflows/:name links resets
  // the canvas to that workflow, while in-page edits (chips) stay plain state like legacy.
  return <WorkflowsBuilder key={name ?? ''} routeName={name} />
}

function WorkflowsBuilder({ routeName }: { routeName: string | undefined }) {
  const workflowsQuery = useWorkflows()
  const skillsQuery = useSkills()
  const uiStateQuery = useUiState()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [autoOpen, setAutoOpen] = useState(false)
  const [autoText, setAutoText] = useState('')
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dragging, setDragging] = useState<DragItem | null>(null)
  // The step id (or CANVAS_ID) the pointer is over mid-drag — drives the "drop to insert"
  // indicator between cards, the affordance the legacy `.wb-gap` slots gave (#wb-drop-line).
  const [overId, setOverId] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  const workflows = workflowsQuery.data?.workflows ?? []
  const skills = skillsQuery.data ?? []
  // The palette lists skills the way every other picker does (#519): most-used first, then
  // project, then global — so what you reach for floats to the top.
  const paletteSkills = orderSkillsByUsage(skills, uiStateQuery.data?.skillUsage)

  // First visit seeds the canvas with the deep-linked workflow when the URL names one, else
  // the repo's first saved workflow — "open the tab, see your flow" (legacy rule). No files
  // yet → an empty canvas + the drop hint.
  useEffect(() => {
    if (draft !== null || workflowsQuery.data === undefined) return
    const list = workflowsQuery.data.workflows
    const wanted =
      (routeName ? list.find((w) => w.name === routeName) : undefined) ??
      list.find((w) => w.source === 'file')
    setDraft(wanted ? draftFrom(wanted) : emptyDraft())
  }, [draft, workflowsQuery.data, routeName])

  const setSteps = (steps: WorkflowStepDef[]) =>
    setDraft((current) => (current === null ? current : { ...current, steps }))

  const importMutation = useMutation({
    mutationFn: (yaml: string) => parseWorkflow(yaml),
    onSuccess: (parsed) => {
      setDraft({ name: parsed.name, description: parsed.description ?? '', steps: parsed.steps })
      setImportOpen(false)
      setImportText('')
      setImportError('')
      toast(`Imported "${parsed.name}" — review, then Save.`)
    },
    onError: (error) => setImportError(error.message),
  })

  // Auto chain creator (#414): the planner turns a plain-language brief into a proposed chain
  // (title + steps) and drops it straight onto the canvas to review, tweak and Save. It never
  // hard-fails — a degraded answer comes back as a one-step plan with `fallback: true`, which we
  // surface as a dim note instead of an error.
  const autoPlan = useMutation({
    mutationFn: (task: string) => postPlan(task),
    onSuccess: (plan) => {
      setDraft((current) => {
        const base = current ?? emptyDraft()
        const { name, steps } = draftFromPlan(plan, base.name)
        return { ...base, name, steps }
      })
      setAutoOpen(false)
      setAutoText('')
      toast(
        plan.fallback
          ? 'Planner unavailable — added a single step. Edit, then Save.'
          : `Built "${plan.name ?? draft?.name ?? 'workflow'}" — review, tweak, then Save.`,
        plan.fallback ? { tone: 'danger' } : undefined,
      )
    },
    onError: (error) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
  })

  const save = useMutation({
    mutationFn: (overwrite: boolean) =>
      createWorkflow({
        ...saveBody(draft?.name ?? '', draft?.description ?? '', draft?.steps ?? []),
        ...(overwrite ? { overwrite: true } : {}),
      }),
    onSuccess: (saved) => {
      setConfirmOverwrite(false)
      toast(`Saved — ${saved.path.split('/').pop() ?? saved.path}`)
      // The chips + the Delete button now reflect the file (and the /new picker lists it).
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
    onError: (error) => {
      if (error instanceof ApiError && error.exists === true) setConfirmOverwrite(true)
      else toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    },
  })

  const del = useMutation({
    mutationFn: (workflowName: string) => deleteWorkflow(workflowName),
    onSuccess: (_, workflowName) => {
      setConfirmDelete(false)
      toast(`Deleted "${workflowName}".`)
      setDraft(emptyDraft())
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
    onError: (error) => {
      setConfirmDelete(false)
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    },
  })

  // dnd-kit defaults on purpose: the small pointer distance keeps card buttons clickable, the
  // sortable coordinate getter is what makes Space/arrows/Space reorder work.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  if (workflowsQuery.isError) {
    return (
      <div data-route="workflows" className="flex min-h-full flex-col">
        <CenteredState
          icon={<TriangleAlertIcon />}
          tone="danger"
          title="Could not load workflows"
          subtitle={workflowsQuery.error.message}
        />
      </div>
    )
  }
  if (draft === null) return <WorkflowsLoading />

  const steps = draft.steps
  const trimmedName = draft.name.trim()
  const savedFile = workflows.find((w) => w.name === trimmedName && w.source === 'file')
  const yaml = workflowYaml(draft.name, draft.description, steps)

  /** Palette → canvas, at `at` (or the end). One rule for drop, click and keyboard: the
   *  server's 8-step limit answers a toast, never a silent no-op. */
  const addSkill = (skill: string, at = steps.length) => {
    if (steps.length >= WB_MAX_STEPS) {
      toast(`A workflow holds at most ${WB_MAX_STEPS} steps.`, { tone: 'danger' })
      return
    }
    setSteps(insertStep(steps, skillStep(skill, steps), at))
  }

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragItem | undefined
    setDragging(data ?? null)
  }

  const handleDragOver = (event: DragOverEvent) => {
    setOverId(event.over ? String(event.over.id) : null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    setOverId(null)
    const { active, over } = event
    if (over === null) return
    const data = active.data.current as DragItem | undefined
    if (data?.type === 'palette') {
      // A drop on a card inserts before it; a drop on the canvas itself appends.
      const at = over.id === CANVAS_ID ? steps.length : steps.findIndex((s) => s.id === over.id)
      addSkill(data.skill, at === -1 ? steps.length : at)
      return
    }
    if (over.id === active.id) return
    const from = steps.findIndex((s) => s.id === active.id)
    const to = steps.findIndex((s) => s.id === over.id)
    if (from !== -1 && to !== -1) setSteps(moveStep(steps, from, to))
  }

  const runImport = () => {
    const text = importText.trim()
    if (text === '') return
    importMutation.mutate(text)
  }

  const runAuto = () => {
    const text = autoText.trim()
    if (text === '' || autoPlan.isPending) return
    autoPlan.mutate(text)
  }

  const runSave = () => {
    if (trimmedName === '') {
      nameInput.current?.focus()
      return
    }
    if (steps.length === 0) {
      toast('Add at least one step first.', { tone: 'danger' })
      return
    }
    save.mutate(false)
  }

  const exportYaml = () => {
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflowSlug(draft.name)}.yaml`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div data-route="workflows" className="flex min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Workflows". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Workflows</h1>
        <p className="text-[13px] text-muted-foreground">
          Portable skill chains — the agent applies them top to bottom.
        </p>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setDragging(null)
          setOverId(null)
        }}
      >
        <div className="flex flex-1 flex-col gap-6 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:flex-row md:p-5 md:pb-5">
          {/* ---- canvas ---------------------------------------------------------------- */}
          <section data-slot="wb-main" className="mx-auto w-full min-w-0 max-w-3xl flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <Input
                  ref={nameInput}
                  data-slot="wb-name"
                  aria-label="Workflow name"
                  spellCheck={false}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  className="h-8 max-w-56 font-mono text-[13px] font-semibold"
                />
                <span data-slot="wb-count" className="shrink-0 font-mono text-xs text-soft-foreground">
                  {stepCountLabel(steps)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {savedFile ? (
                  <Button
                    type="button"
                    variant="danger-ghost"
                    size="sm"
                    data-slot="wb-delete"
                    title="Delete the saved workflow file"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2Icon aria-hidden="true" className="size-3" />
                    Delete
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-slot="wb-auto"
                  aria-expanded={autoOpen}
                  title="Describe a chain — the agent builds it"
                  onClick={() => {
                    setImportOpen(false)
                    setAutoOpen((open) => !open)
                  }}
                >
                  <WandSparklesIcon aria-hidden="true" className="size-3" />
                  Auto
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-slot="wb-import"
                  onClick={() => {
                    setImportError('')
                    setAutoOpen(false)
                    setImportOpen((open) => !open)
                  }}
                >
                  <UploadIcon aria-hidden="true" className="size-3" />
                  Import
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-slot="wb-export"
                  title="Download workflow.yaml"
                  onClick={exportYaml}
                >
                  <DownloadIcon aria-hidden="true" className="size-3" />
                  Export
                </Button>
                <Button
                  type="button"
                  variant="contrast"
                  size="sm"
                  data-slot="wb-save"
                  disabled={save.isPending}
                  onClick={runSave}
                >
                  <CheckIcon aria-hidden="true" className="size-3" />
                  Save
                </Button>
              </div>
            </div>

            {/* Load chips: every known workflow, plus "+ new" — the legacy edit row. */}
            <div data-slot="wb-load" className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[11px] font-medium tracking-wide text-soft-foreground uppercase">
                edit
              </span>
              {workflows.map((workflow) => (
                <button
                  key={workflow.name}
                  type="button"
                  data-slot="wb-load-chip"
                  data-name={workflow.name}
                  title={workflow.description ?? ''}
                  aria-pressed={trimmedName === workflow.name}
                  onClick={() => setDraft(draftFrom(workflow))}
                  className={cn(
                    'rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    trimmedName === workflow.name && 'border-primary/40 bg-primary/10 text-foreground',
                  )}
                >
                  {workflow.name}
                </button>
              ))}
              <button
                type="button"
                data-slot="wb-new"
                title="Start an empty workflow"
                onClick={() => setDraft(emptyDraft())}
                className="rounded-full border border-dashed border-border px-2.5 py-1 font-mono text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                + new
              </button>
            </div>

            {autoOpen ? (
              <div data-slot="wb-auto-panel" className="mt-4 rounded-lg border border-border bg-card p-3 shadow-xs">
                <div className="text-[11px] font-medium tracking-wide text-soft-foreground uppercase">
                  Build a chain from a prompt
                </div>
                <p className="mt-1 text-xs leading-relaxed text-soft-foreground">
                  Describe what the chain should do. An agent proposes a title and an ordered set of
                  skill / check steps — land it on the canvas, then tweak and Save.
                </p>
                <Textarea
                  data-slot="wb-auto-text"
                  aria-label="Describe the chain to build"
                  rows={3}
                  autoFocus
                  placeholder="e.g. Fix the bug, run the tests, then review the diff for regressions."
                  value={autoText}
                  onChange={(event) => setAutoText(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      runAuto()
                    }
                  }}
                  className="mt-2 min-h-20 text-[13px]"
                />
                <div className="mt-3 flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="contrast"
                    size="sm"
                    data-slot="wb-auto-run"
                    disabled={autoPlan.isPending || autoText.trim() === ''}
                    onClick={runAuto}
                  >
                    <WandSparklesIcon aria-hidden="true" className="size-3" />
                    {autoPlan.isPending ? 'Building…' : 'Build chain'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-slot="wb-auto-cancel"
                    onClick={() => {
                      setAutoOpen(false)
                      setAutoText('')
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {importOpen ? (
              <div data-slot="wb-import-panel" className="mt-4 rounded-lg border border-border bg-card p-3 shadow-xs">
                <div className="text-[11px] font-medium tracking-wide text-soft-foreground uppercase">
                  Import workflow YAML
                </div>
                <Textarea
                  data-slot="wb-import-text"
                  aria-label="Workflow YAML to import"
                  rows={6}
                  spellCheck={false}
                  placeholder={'name: my-flow\nskills:\n  - test-conventions\n  - commit-style'}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  className="mt-2 min-h-28 font-mono text-xs"
                />
                {importError !== '' ? (
                  <p data-slot="wb-import-error" className="mt-2 text-xs text-danger">
                    {importError}
                  </p>
                ) : null}
                <div className="mt-3 flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="contrast"
                    size="sm"
                    data-slot="wb-import-run"
                    disabled={importMutation.isPending}
                    onClick={runImport}
                  >
                    Import
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-slot="wb-import-cancel"
                    onClick={() => {
                      setImportOpen(false)
                      setImportText('')
                      setImportError('')
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            <Canvas
              steps={steps}
              skills={skills}
              dragging={dragging !== null}
              overId={overId}
              activeStepId={dragging?.type === 'step' ? dragging.step.id : null}
              onRemove={(index) => setSteps(removeStep(steps, index))}
            />
          </section>

          {/* ---- palette + YAML preview ------------------------------------------------- */}
          <aside data-slot="wb-aside" className="w-full shrink-0 md:w-[320px]">
            <div className="text-[11px] font-medium tracking-wide text-soft-foreground uppercase">Skills</div>
            <p className="mt-1 text-xs leading-relaxed text-soft-foreground">
              Drag into the flow. Order is execution order — the agent applies them top to bottom.
            </p>
            <Input
              data-slot="wb-filter"
              placeholder="Filter skills…"
              aria-label="Filter skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="mt-2.5 h-8 text-[13px]"
            />
            <Palette
              skills={paletteSkills}
              query={query}
              error={skillsQuery.isError ? skillsQuery.error.message : null}
              inFlow={new Set(steps.map((s) => s.skill).filter((s): s is string => Boolean(s)))}
              onAdd={(skill) => addSkill(skill)}
            />

            <div className="mt-5 flex items-center gap-2">
              <span className="text-[11px] font-medium tracking-wide text-soft-foreground uppercase">
                workflow.yaml
              </span>
              <span className="flex-1" />
              <CopyYamlButton yaml={yaml} />
            </div>
            <pre
              data-slot="wb-yaml"
              className="mt-2 overflow-x-auto rounded-lg border border-border bg-card p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-muted-foreground shadow-xs"
            >
              {yaml}
            </pre>
            <p className="mt-2 text-[11.5px] leading-relaxed text-soft-foreground">
              Portable — export this file and import it in any repo running cezar.
            </p>
          </aside>
        </div>

        {/* What the pointer carries mid-drag: a copy of the pill/card, per dnd-kit. */}
        <DragOverlay>
          {dragging?.type === 'palette' ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[13px] font-medium shadow-md">
              <SparklesIcon aria-hidden="true" className="size-3.5 text-primary" />
              {dragging.skill}
            </div>
          ) : dragging?.type === 'step' ? (
            <StepCardBody step={dragging.step} index={steps.findIndex((s) => s.id === dragging.step.id)} skills={skills} overlay />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Save-over confirm: the server answered 409 `exists` — legacy `confirm()`, as a dialog. */}
      <AlertDialog open={confirmOverwrite} onOpenChange={(open) => !open && setConfirmOverwrite(false)}>
        <AlertDialogContent data-slot="wb-overwrite-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>&ldquo;{trimmedName}&rdquo; already exists</AlertDialogTitle>
            <AlertDialogDescription>
              Saving overwrites the existing workflow file. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the file</AlertDialogCancel>
            <AlertDialogAction data-slot="wb-overwrite-confirm" onClick={() => save.mutate(true)}>
              Overwrite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
        <AlertDialogContent data-slot="wb-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow &ldquo;{trimmedName}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes {savedFile?.path?.split('/').pop() ?? 'the saved file'} from{' '}
              <span className="font-mono">.ai/cezar/workflows/</span>. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-slot="wb-delete-confirm"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => del.mutate(trimmedName)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The step list: one droppable + sortable column. Empty → the legacy drop hint. */
function Canvas({
  steps,
  skills,
  dragging,
  overId,
  activeStepId,
  onRemove,
}: {
  steps: WorkflowStepDef[]
  skills: readonly Skill[]
  /** A drag (palette or step) is in flight — reveals the between-card insert affordances. */
  dragging: boolean
  /** The step id (or CANVAS_ID) under the pointer, for the insert line. */
  overId: string | null
  /** The id of the step BEING dragged — never draw an insert line against itself. */
  activeStepId: string | null
  onRemove: (index: number) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: CANVAS_ID })
  // Append target: the pointer is over the canvas padding (below the last card), not a card.
  const appendActive = dragging && overId === CANVAS_ID
  return (
    <div
      ref={setNodeRef}
      data-slot="wb-steps"
      data-dragging={dragging || undefined}
      className={cn(
        'mt-4 rounded-lg border border-dashed p-2 transition-colors',
        isOver ? 'border-primary/60 bg-primary/5' : 'border-muted-foreground/25',
      )}
    >
      {steps.length === 0 ? (
        <p
          className={cn(
            'rounded-md px-3 py-10 text-center text-[13px] transition-colors',
            isOver ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          Drop a skill here — or Import a workflow.yaml
        </p>
      ) : (
        <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-2.5">
            {steps.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                index={index}
                skills={skills}
                connector={index > 0}
                dragging={dragging}
                // The insert line rides above the hovered card — unless that card is the one
                // being dragged (dropping onto itself is a no-op, so no line).
                insertBefore={dragging && overId === step.id && activeStepId !== step.id}
                onRemove={() => onRemove(index)}
              />
            ))}
          </ol>
          {/* Appending below the last card: the same accent slot, at the tail. */}
          <div
            aria-hidden="true"
            className={cn(
              'mx-1 mt-2.5 h-[3px] rounded-full transition-colors',
              appendActive ? 'bg-primary' : 'bg-transparent',
            )}
          />
          <div className="flex items-center justify-center gap-1.5 pt-1.5 pb-1 text-[11px] text-muted-foreground">
            <ArrowDownIcon aria-hidden="true" className="size-3" />
            runs top to bottom
          </div>
        </SortableContext>
      )}
    </div>
  )
}

function StepCard({
  step,
  index,
  skills,
  connector,
  dragging,
  insertBefore,
  onRemove,
}: {
  step: WorkflowStepDef
  index: number
  skills: readonly Skill[]
  /** Draw the rest-state vertical hairline linking this card to the one above (every card but
   *  the first) — the legacy `.wb-gap` connector. */
  connector: boolean
  /** A drag is in flight — hide the rest connector so it doesn't compete with the insert line. */
  dragging: boolean
  /** The drop indicator sits in the gap above this card. */
  insertBefore: boolean
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
    data: { type: 'step', step } satisfies DragItem,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-40')}
    >
      {/* Rest connector: a hairline down the middle of the gap, linking consecutive skills. */}
      {connector && !dragging ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-[11px] left-1/2 h-[9px] w-px -translate-x-1/2 bg-muted-foreground/30"
        />
      ) : null}
      {/* Drop-to-insert line: an accent bar in the gap above, where the card will land. */}
      {insertBefore ? (
        <span
          aria-hidden="true"
          data-slot="wb-drop-line"
          className="pointer-events-none absolute -top-[7px] right-0 left-0 h-[3px] rounded-full bg-primary"
        />
      ) : null}
      <StepCardBody
        step={step}
        index={index}
        skills={skills}
        onRemove={onRemove}
        gripProps={{ ...attributes, ...listeners }}
      />
    </li>
  )
}

/**
 * The card itself, shared with the DragOverlay (which renders it detached — no sortable hooks).
 * `gripProps` carries dnd-kit's `attributes` (role, tabIndex, aria) onto the grip button so the
 * keyboard path lifts from a real focusable control.
 */
function StepCardBody({
  step,
  index,
  skills,
  onRemove,
  gripProps,
  overlay = false,
}: {
  step: WorkflowStepDef
  index: number
  skills: readonly Skill[]
  onRemove?: () => void
  gripProps?: Record<string, unknown>
  overlay?: boolean
}) {
  const known = skills.find((skill) => skill.name === step.skill)
  const isCheck = Boolean(step.command)
  const title = isCheck || !step.skill ? (step.name ?? step.id) : step.skill
  const description = isCheck
    ? `$ ${step.command}${step.onFail ? ` — on fail retry from "${step.onFail.retry}" (×${step.onFail.max ?? 2})` : ''}`
    : step.skill
      ? (known?.description ??
        'Not in this repo or the team skills — the step runs on its plain prompt.')
      : (step.prompt ?? '')
  const badge = isCheck ? 'check' : step.skill ? (known ? null : 'unknown') : 'prompt'

  return (
    <div
      data-slot="wb-step"
      data-id={step.id}
      data-index={index}
      className={cn(
        // `bg-card-2` + a slightly stronger border: a white-on-white card with a `#ebebeb`
        // border all but vanished on the light page (the workflows low-contrast finding).
        'flex items-center gap-2.5 rounded-md border border-muted-foreground/20 bg-card-2 px-2.5 py-2 shadow-xs',
        overlay && 'shadow-md',
      )}
    >
      <button
        type="button"
        data-slot="wb-step-grip"
        aria-label={`Reorder step ${index + 1}: ${title}`}
        className="shrink-0 cursor-grab rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        {...gripProps}
      >
        <GripVerticalIcon aria-hidden="true" className="size-3.5" />
      </button>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {String(index + 1).padStart(2, '0')}
      </span>
      {isCheck ? (
        <SquareTerminalIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
      ) : (
        <SparklesIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[13px] font-medium">{title}</div>
        {description ? (
          <div className="truncate text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {badge ? (
        <span
          data-slot="wb-step-badge"
          className={cn(
            'shrink-0 rounded-full border px-2 py-px font-mono text-[10.5px]',
            badge === 'check' && 'border-success/30 text-success',
            badge === 'unknown' && 'border-danger/35 text-danger',
            badge === 'prompt' && 'border-border text-soft-foreground',
          )}
        >
          {badge}
        </span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          data-slot="wb-step-remove"
          aria-label={`Remove step ${index + 1}: ${title}`}
          title="Remove from flow"
          onClick={onRemove}
          className="shrink-0 rounded p-0.5 text-soft-foreground transition-colors outline-none hover:text-danger focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

function Palette({
  skills,
  query,
  error,
  inFlow,
  onAdd,
}: {
  skills: readonly Skill[]
  query: string
  error: string | null
  inFlow: ReadonlySet<string>
  onAdd: (skill: string) => void
}) {
  if (error !== null) {
    return (
      <p data-slot="wb-palette" className="mt-2.5 text-xs text-danger">
        Could not load skills: {error}
      </p>
    )
  }
  const needle = query.trim().toLowerCase()
  // `skills` arrives already ordered (project-first, then recency — #408/#414); the filter
  // preserves that order, it never re-sorts.
  const shown = skills.filter(
    (skill) =>
      needle === '' ||
      skill.name.toLowerCase().includes(needle) ||
      (skill.description ?? '').toLowerCase().includes(needle),
  )
  return (
    <div data-slot="wb-palette" className="mt-2.5 flex flex-col gap-1">
      {shown.length > 0 ? (
        shown.map((skill) => (
          <PaletteSkill key={skill.path} skill={skill} inFlow={inFlow.has(skill.name)} onAdd={onAdd} />
        ))
      ) : (
        <p className="py-1 text-xs leading-relaxed text-soft-foreground">
          {skills.length > 0 ? 'No skills match.' : <SkillEmptyHintCompact />}
        </p>
      )}
    </div>
  )
}

/** A palette pill: a dnd-kit drag source that COPIES into the flow, plus an explicit add
 *  button — the same insert without a pointer (and what tests exercise deterministically). */
function PaletteSkill({
  skill,
  inFlow,
  onAdd,
}: {
  skill: Skill
  inFlow: boolean
  onAdd: (skill: string) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${skill.name}`,
    data: { type: 'palette', skill: skill.name } satisfies DragItem,
  })
  return (
    <div
      ref={setNodeRef}
      data-slot="wb-skill"
      data-skill={skill.name}
      title={skill.description ?? ''}
      className={cn(
        'flex cursor-grab items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 shadow-xs transition-colors hover:bg-muted',
        isDragging && 'opacity-40',
      )}
      {...attributes}
      {...listeners}
    >
      <SparklesIcon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', isProjectSkill(skill) ? 'text-violet' : 'text-soft-foreground')}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[13px]',
          isProjectSkill(skill) ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
        )}
      >
        {skill.name}
      </span>
      {inFlow ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" /> : null}
      <button
        type="button"
        data-slot="wb-skill-add"
        aria-label={`Add ${skill.name} to the flow`}
        title="Add to the flow"
        onClick={() => onAdd(skill.name)}
        className="shrink-0 rounded p-0.5 text-soft-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <PlusIcon aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}

/** Copy flips to "✓ Copied" for a beat — the legacy `wbCopy` affordance. */
function CopyYamlButton({ yaml }: { yaml: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      data-slot="wb-copy"
      title="Copy the YAML"
      onClick={() => {
        void navigator.clipboard?.writeText(yaml).catch(() => {})
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      }}
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? (
        <>
          <CheckIcon aria-hidden="true" className="size-3 text-success" />
          Copied
        </>
      ) : (
        <>
          <CopyIcon aria-hidden="true" className="size-3" />
          Copy
        </>
      )}
    </button>
  )
}
