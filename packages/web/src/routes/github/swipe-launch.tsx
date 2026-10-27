import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlayIcon, SearchIcon, SparklesIcon, WorkflowIcon } from 'lucide-react'
import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'

import { createRun, putUiState } from '@/api/client'
import { queryKeys, useUiState } from '@/api/queries'
import type { GithubItem, Skill, WorkflowDef } from '@open-mercato/cezar-api-client'
import { AgentProviderGate } from '@/components/agent-provider-gate'
import { engineRunBody, useResolvedEngine, type EnginePick } from '@/components/engine-pills'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { toast } from '@/components/ui/toaster'
import { githubRunBody, githubTaskRef } from '@/lib/github-task'
import { bumpSkillUsage, searchSkills, searchWorkflows } from '@/lib/skills'
import { trackMessageSent } from '@/lib/telemetry'
import { cn } from '@/lib/utils'

/** How far a row must travel left before releasing it opens the launcher. */
export const SWIPE_TRIGGER_PX = 72
const SWIPE_MAX_PX = 112
/** Movement below this is still a tap; past it the gesture locks to one axis. */
const AXIS_LOCK_PX = 10

interface Gesture {
  id: number
  x: number
  y: number
  axis: 'x' | 'y' | null
}

/**
 * Swipe-left on a list row (touch only — a mouse drag stays the drag-into-composer gesture).
 * The row needs `touch-action: pan-y` so vertical scrolling stays the browser's and horizontal
 * moves reach us; a vertical pan ends in `pointercancel`, which drops the gesture.
 */
export function useRowSwipe(onTrigger: () => void) {
  const [offset, setOffset] = useState(0)
  const gesture = useRef<Gesture | null>(null)
  // A completed horizontal swipe must not also navigate the row's link. Browsers often send no
  // click after a moved touch, so any later press (pointer or key) clears the flag first.
  const swallowClick = useRef(false)

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    swallowClick.current = false
    if (event.pointerType !== 'touch') return
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null }
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current
    if (!current || current.id !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (current.axis === null) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
      current.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (current.axis !== 'x') return
    swallowClick.current = true
    setOffset(Math.max(-SWIPE_MAX_PX, Math.min(0, dx)))
  }
  const finish = (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const current = gesture.current
    if (!current || current.id !== event.pointerId) return
    gesture.current = null
    setOffset(0)
    if (!cancelled && current.axis === 'x' && event.clientX - current.x <= -SWIPE_TRIGGER_PX) onTrigger()
  }
  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  return {
    offset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: PointerEvent<HTMLElement>) => finish(event, false),
      onPointerCancel: (event: PointerEvent<HTMLElement>) => finish(event, true),
      onClickCapture,
      onKeyDown: () => {
        swallowClick.current = false
      },
    },
  }
}

/** What sits behind a row while it is being swiped. */
export function SwipeReveal({ offset }: { offset: number }) {
  if (offset === 0) return null
  const armed = offset <= -SWIPE_TRIGGER_PX
  return (
    <span
      aria-hidden="true"
      data-slot="gh-swipe-reveal"
      className={cn(
        'absolute inset-y-0 right-0 flex items-center gap-1.5 rounded-md px-4 text-xs font-semibold transition-colors',
        armed ? 'bg-violet text-violet-foreground' : 'bg-violet/15 text-violet',
      )}
    >
      <PlayIcon className="size-3.5" />
      Run…
    </span>
  )
}

/**
 * The swipe's launcher: a bottom sheet listing workflows and skills, where ONE tap starts the
 * run. The body is `githubRunBody` with the item reference as the prompt — the same run the
 * detail pane's untouched "Run agent" button would start for that one pick. It deliberately
 * leaves the detail pane's remembered picker selection alone: a swipe is a one-off.
 */
export function SwipeLaunchSheet({
  item,
  open,
  onOpenChange,
  workflows,
  skills,
  engine,
  onQueued,
}: {
  item: GithubItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  workflows: readonly WorkflowDef[]
  /** Already ordered most-used → project → global (`orderSkillsByUsage`). */
  skills: readonly Skill[]
  engine: EnginePick
  onQueued: (url: string, runId: string) => void
}) {
  const queryClient = useQueryClient()
  const uiState = useUiState()
  const resolved = useResolvedEngine(engine)
  const [query, setQuery] = useState('')

  const start = useMutation({
    mutationFn: async (pick: { target: GithubItem; workflow: string | null; skill: string | null }) => {
      const body = githubRunBody(
        pick.target,
        pick.workflow,
        pick.skill ? [pick.skill] : [],
        githubTaskRef(pick.target),
        engineRunBody(resolved),
      )
      return { pick, created: await createRun(body) }
    },
    onSuccess: ({ pick, created }) => {
      trackMessageSent('github')
      const run = 'runs' in created ? created.runs[0] : created
      if (run) onQueued(pick.target.url, run.id)
      toast(`Added to the queue — ${pick.target.kind === 'pr' ? 'PR' : 'issue'} #${pick.target.number}`)
      onOpenChange(false)
      setQuery('')
      // Same guard as HandToAgent: the PUT replaces the whole map, so bump only off a known one.
      if (pick.skill && uiState.data !== undefined) {
        void putUiState({ skillUsage: bumpSkillUsage(uiState.data.skillUsage, pick.skill) })
          .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
          .catch(() => {})
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const launch = (workflow: string | null, skill: string | null) => {
    if (!item || start.isPending || !resolved.canRun) return
    start.mutate({ target: item, workflow, skill })
  }
  const disabled = start.isPending || !resolved.canRun
  const shownWorkflows = searchWorkflows(workflows, query)
  const shownSkills = searchSkills([...skills], query, uiState.data?.skillUsage)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
    >
      <SheetContent
        side="bottom"
        data-slot="gh-swipe-sheet"
        // Focusing the filter would pop the phone keyboard over the list the user came to tap.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="max-h-[85dvh] gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="truncate text-base">
            Run agent on {item ? `${item.kind === 'pr' ? 'PR' : 'issue'} #${item.number}` : '…'}
          </SheetTitle>
          <SheetDescription className="truncate text-xs">
            {item?.title ?? ''} — tap a workflow or skill to start.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4 pb-2">
          <AgentProviderGate resolved={resolved} dataSlot="gh-swipe-provider-gate" />
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-soft-foreground"
            />
            <input
              type="search"
              data-slot="gh-swipe-filter"
              aria-label="Filter workflows and skills"
              placeholder="Filter workflows and skills…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full rounded-md border border-input bg-card py-2 pr-2 pl-7 text-[14px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {shownWorkflows.length > 0 ? (
            <LaunchGroup label="Workflows">
              {shownWorkflows.map((def) => (
                <LaunchOption
                  key={def.name}
                  slot="gh-swipe-workflow"
                  name={def.name}
                  description={def.description}
                  icon={<WorkflowIcon aria-hidden="true" className="size-4 shrink-0 text-violet" />}
                  disabled={disabled}
                  onClick={() => launch(def.name, null)}
                />
              ))}
            </LaunchGroup>
          ) : null}
          {shownSkills.length > 0 ? (
            <LaunchGroup label="Skills">
              {shownSkills.map((skill) => (
                <LaunchOption
                  key={skill.name}
                  slot="gh-swipe-skill"
                  name={skill.name}
                  description={skill.description}
                  icon={<SparklesIcon aria-hidden="true" className="size-4 shrink-0 text-success" />}
                  disabled={disabled}
                  onClick={() => launch(null, skill.name)}
                />
              ))}
            </LaunchGroup>
          ) : null}
          {shownWorkflows.length === 0 && shownSkills.length === 0 ? (
            <p className="px-2 py-3 text-sm text-soft-foreground">Nothing matches “{query.trim()}”.</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function LaunchGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="pt-2">
      <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-soft-foreground uppercase">{label}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}

function LaunchOption({
  slot,
  name,
  description,
  icon,
  disabled,
  onClick,
}: {
  slot: string
  name: string
  description?: string | null
  icon: ReactNode
  disabled: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        data-slot={slot}
        data-name={name}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted active:bg-muted disabled:opacity-55"
      >
        {icon}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-[13px] font-medium">{name}</span>
          {description ? <span className="truncate text-xs text-soft-foreground">{description}</span> : null}
        </span>
      </button>
    </li>
  )
}
