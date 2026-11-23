import type { AttentionSettled, RunRecord } from '@open-mercato/cezar-api-client'
import {
  ArchiveIcon,
  BellIcon,
  BellOffIcon,
  LinkIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SquareIcon,
  UndoIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { runActionFlags } from '@/routes/task-thread/run-actions'

import { SNOOZE_LABEL, type SnoozeChoice, type TriageTarget } from './now-triage-model'

/**
 * Needs you triage controls (spec 2026-11-23-needs-you-triage): the row's ✕, its ⋯ menu (also on
 * right-click), the phone's swipe, and the collapsed Probably done group.
 */

export interface TriageActions {
  dismiss: (target: TriageTarget) => void
  /** Probably done's "Dismiss all": one toast, one undo. */
  dismissAll: (targets: TriageTarget[]) => void
  snooze: (target: TriageTarget, choice: SnoozeChoice) => void
  /** "Still needs me": overrides the Probably done verdict. */
  keep: (target: TriageTarget) => void
  /** Task actions, for this project's own runs only. */
  finish?: (run: RunRecord) => void
  archive?: (run: RunRecord) => void
  cancel?: (run: RunRecord) => void
  /** The manager's own Notify switch: its items stay listed and leave every count. */
  mute?: (manager: { id: string; name: string }, muted: boolean) => void
  managerMuted?: (managerId: string) => boolean
  copyLink?: (path: string) => void
}

const SNOOZES: SnoozeChoice[] = ['hour', 'evening', 'tomorrow', 'week']

/** The ✕: on hover or focus with a mouse; a phone swipes instead. */
export function DismissButton({ target, actions, className }: { target: TriageTarget; actions: TriageActions; className?: string }) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      data-slot="now-dismiss"
      aria-label={target.questionKey ? 'Dismiss and close the question' : 'Dismiss'}
      title={target.questionKey ? 'Dismiss: closes the question for whoever asked it' : 'Dismiss until it changes'}
      className={cn('size-8 text-muted-foreground pointer-coarse:hidden md:opacity-0 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100', className)}
      onClick={() => actions.dismiss(target)}
    >
      <XIcon className="size-4" aria-hidden="true" />
    </Button>
  )
}

/** The ⋯ menu. `open`/`onOpenChange` let the row open it on right-click. */
export function TriageMenu({
  target,
  actions,
  href,
  run,
  settled,
  manager,
  copyHref,
  open,
  onOpenChange,
}: {
  target: TriageTarget
  actions: TriageActions
  /** Where Open goes. */
  href: string
  /** This project's run behind the row: enables the task actions. */
  run?: RunRecord | undefined
  settled?: AttentionSettled | undefined
  /** A manager's item: Mute or Unmute that manager. */
  manager?: { id: string; name: string } | undefined
  /** The app path Copy link shares; absent, no Copy link. */
  copyHref?: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const flags = run ? runActionFlags(run) : undefined
  const finish = run && flags?.finish && actions.finish
  const archive = run && !run.archived && actions.archive && run.status !== 'running' && run.status !== 'queued'
  const cancel = run && flags?.cancel && actions.cancel
  const muted = manager ? actions.managerMuted?.(manager.id) ?? false : false
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon" variant="ghost" data-slot="now-more" aria-label="More actions" className="size-8 text-muted-foreground">
          <MoreHorizontalIcon className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" data-slot="now-menu">
        <DropdownMenuItem onSelect={() => navigate(href)}>
          <ExternalLinkIcon aria-hidden="true" /> Open
        </DropdownMenuItem>
        {settled ? (
          <DropdownMenuItem data-slot="now-menu-keep" onSelect={() => actions.keep(target)}>
            <UndoIcon aria-hidden="true" /> Still needs me
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-slot="now-menu-dismiss" onSelect={() => actions.dismiss(target)}>
          <XIcon aria-hidden="true" /> {target.questionKey ? 'Dismiss and close the question' : 'Dismiss'}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-slot="now-menu-snooze">
            <ClockIcon aria-hidden="true" className="size-4 text-muted-foreground" /> Snooze
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {SNOOZES.map((choice) => (
              <DropdownMenuItem key={choice} data-slot="now-snooze" data-choice={choice} onSelect={() => actions.snooze(target, choice)}>
                {SNOOZE_LABEL[choice]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {(manager && actions.mute) || (copyHref && actions.copyLink) ? <DropdownMenuSeparator /> : null}
        {manager && actions.mute ? (
          <DropdownMenuItem data-slot="now-menu-mute" data-muted={muted || undefined} onSelect={() => actions.mute!(manager, !muted)}>
            {muted ? <BellIcon aria-hidden="true" /> : <BellOffIcon aria-hidden="true" />}
            {muted ? 'Unmute this manager' : 'Mute this manager'}
          </DropdownMenuItem>
        ) : null}
        {copyHref && actions.copyLink ? (
          <DropdownMenuItem data-slot="now-menu-copy" onSelect={() => actions.copyLink!(copyHref)}>
            <LinkIcon aria-hidden="true" /> Copy link
          </DropdownMenuItem>
        ) : null}
        {finish || archive || cancel ? <DropdownMenuSeparator /> : null}
        {finish ? (
          <DropdownMenuItem data-slot="now-menu-finish" onSelect={() => actions.finish!(run)}>
            <CheckCheckIcon aria-hidden="true" /> Mark done
          </DropdownMenuItem>
        ) : null}
        {archive ? (
          <DropdownMenuItem data-slot="now-menu-archive" onSelect={() => actions.archive!(run)}>
            <ArchiveIcon aria-hidden="true" /> Archive task
          </DropdownMenuItem>
        ) : null}
        {cancel ? (
          <DropdownMenuItem data-slot="now-menu-cancel" variant="destructive" onSelect={() => actions.cancel!(run)}>
            <SquareIcon aria-hidden="true" /> Stop task…
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Right-click opens the row's menu, as on a desktop list. */
export function useRowMenu(): { open: boolean; setOpen: (open: boolean) => void; onContextMenu: (event: React.MouseEvent) => void } {
  const [open, setOpen] = React.useState(false)
  const onContextMenu = React.useCallback((event: React.MouseEvent) => {
    // A link's own context menu (open in a new tab) stays the browser's.
    if ((event.target as HTMLElement).closest('a[href]:not([data-slot="now-row-link"])')) return
    event.preventDefault()
    setOpen(true)
  }, [])
  return { open, setOpen, onContextMenu }
}

const SETTLED_ICON: Record<AttentionSettled['why'], typeof CheckIcon> = {
  'pr-merged': CheckIcon,
  'pr-closed': CheckIcon,
  'work-ended': CheckIcon,
  overtaken: RefreshCwIcon,
  quiet: ClockIcon,
}

/** Why a row sits in Probably done. */
export function SettledReason({ settled }: { settled: AttentionSettled }) {
  const Icon = SETTLED_ICON[settled.why]
  const done = settled.why === 'pr-merged' || settled.why === 'pr-closed' || settled.why === 'work-ended'
  return (
    <span
      data-slot="now-settled"
      data-why={settled.why}
      className={cn(
        'inline-flex h-5 max-w-full items-center gap-1 rounded-md px-1.5 text-meta',
        done ? 'bg-success/12 text-success' : 'bg-warning/12 text-warning',
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{settled.detail}</span>
    </span>
  )
}

/** The collapsed group under Needs you: listed, never counted, one click from gone. */
export function ProbablyDoneGroup({ count, onDismissAll, children }: { count: number; onDismissAll: () => void; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  if (count === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="now-probably-done" className="mt-1.5 rounded-[10px] border border-dashed border-border">
      <div className="flex items-center gap-2 px-2 py-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-slot="now-probably-done-toggle"
            className="flex min-h-9 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-label text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden="true" />
            Probably done
            <span className="rounded-full bg-muted px-1.5 font-mono text-micro font-medium text-foreground tabular-nums">{count}</span>
            <span className="text-soft-foreground">· not counted</span>
          </button>
        </CollapsibleTrigger>
        <Button type="button" size="sm" variant="ghost" data-slot="now-dismiss-all" onClick={onDismissAll}>
          <BellOffIcon className="size-3.5" aria-hidden="true" />
          Dismiss all
        </Button>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-1.5 px-1.5 pb-1.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const ACTIONS_WIDTH = 152
const OPEN_AT = ACTIONS_WIDTH / 2
const SWIPE_HINT_KEY = 'cez.now.swipeHint'

function hintSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(SWIPE_HINT_KEY) === '1'
  } catch {
    return true
  }
}

function markHintSeen(): void {
  try {
    globalThis.localStorage?.setItem(SWIPE_HINT_KEY, '1')
  } catch {
    // private mode: the hint plays again next visit
  }
}

/**
 * The phone's swipe: left REVEALS Snooze and Dismiss, and a tap on one acts. A swipe alone never
 * dismisses (owner decision). A grip on the row's edge and a one-time peek say the row moves.
 */
export function SwipeRow({
  target,
  actions,
  hint = false,
  children,
}: {
  target: TriageTarget
  actions: TriageActions
  /** The first row peeks once, so the gesture is discoverable. */
  hint?: boolean
  children: React.ReactNode
}) {
  const [offset, setOffset] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  const start = React.useRef<{ x: number; y: number; base: number; horizontal?: boolean } | null>(null)
  const moved = React.useRef(false)
  const root = React.useRef<HTMLDivElement>(null)
  const open = offset <= -OPEN_AT

  React.useEffect(() => {
    if (!hint || hintSeen() || !globalThis.matchMedia?.('(pointer: coarse)').matches) return
    const peek = setTimeout(() => setOffset(-56), 700)
    const back = setTimeout(() => { setOffset(0); markHintSeen() }, 1500)
    return () => { clearTimeout(peek); clearTimeout(back) }
  }, [hint])

  // A tap anywhere else closes revealed actions.
  React.useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOffset(0)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType !== 'touch') return
    start.current = { x: event.clientX, y: event.clientY, base: offset }
    moved.current = false
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const from = start.current
    if (!from) return
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    if (from.horizontal === undefined) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      from.horizontal = Math.abs(dx) > Math.abs(dy)
    }
    if (!from.horizontal) return
    moved.current = true
    setDragging(true)
    setOffset(Math.max(-ACTIONS_WIDTH - 24, Math.min(0, from.base + dx)))
  }
  const onPointerEnd = () => {
    if (!start.current) return
    start.current = null
    setDragging(false)
    setOffset((current) => (current <= -OPEN_AT ? -ACTIONS_WIDTH : 0))
  }

  return (
    <div ref={root} data-slot="now-swipe" data-open={open || undefined} className="relative overflow-hidden rounded-[10px]">
      <div
        data-slot="now-swipe-actions"
        aria-hidden={!open}
        className={cn('absolute inset-y-0 right-0 flex items-stretch', offset === 0 && 'invisible')}
        style={{ width: ACTIONS_WIDTH }}
      >
        <SwipeSnooze target={target} actions={actions} tabbable={open} onDone={() => setOffset(0)} />
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          data-slot="now-swipe-dismiss"
          className="flex flex-1 flex-col items-center justify-center gap-0.5 bg-muted text-meta font-semibold text-foreground"
          onClick={() => { setOffset(0); actions.dismiss(target) }}
        >
          <XIcon className="size-4" aria-hidden="true" />
          Dismiss
        </button>
      </div>
      <div
        className={cn('relative touch-pan-y', !dragging && 'transition-transform duration-200 motion-reduce:transition-none')}
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(event) => {
          // The swipe's own release is not a tap on the row's link.
          if (moved.current) { event.preventDefault(); event.stopPropagation(); moved.current = false }
        }}
      >
        {children}
        {/* The grip: this row slides. Touch screens only. */}
        <span aria-hidden="true" data-slot="now-swipe-grip" className="pointer-events-none absolute top-1/2 right-1 hidden h-7 w-1 -translate-y-1/2 rounded-full bg-border pointer-coarse:block" />
      </div>
    </div>
  )
}

function SwipeSnooze({ target, actions, tabbable, onDone }: { target: TriageTarget; actions: TriageActions; tabbable: boolean; onDone: () => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={tabbable ? 0 : -1}
          data-slot="now-swipe-snooze"
          className="flex flex-1 flex-col items-center justify-center gap-0.5 bg-warning/20 text-meta font-semibold text-warning"
        >
          <ClockIcon className="size-4" aria-hidden="true" />
          Snooze
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SNOOZES.map((choice) => (
          <DropdownMenuItem key={choice} onSelect={() => { onDone(); actions.snooze(target, choice) }}>
            {SNOOZE_LABEL[choice]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
