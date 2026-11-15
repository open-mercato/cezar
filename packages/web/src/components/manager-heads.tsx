import { ChevronRightIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type Ref } from 'react'
import { Link, useLocation } from 'react-router'

import { useManagers } from '@/api/managers'
import { useHealth, useProjects } from '@/api/queries'
import { Kbd } from '@/components/kbd'
import { Button } from '@/components/ui/button'
import { formatChord } from '@/lib/keybindings'
import {
  HEAD_KIND_LABEL,
  HEAD_KIND_PHRASE,
  HEADS_LATER_KEY,
  HEADS_SEEN_KEY,
  diffArrivals,
  headAnnouncement,
  headCount,
  headLine,
  needsYou,
  readHeadMemory,
  restingHeads,
  settleLater,
  writeHeadMemory,
  type Head,
  type HeadKind,
  type HeadMemory,
} from '@/lib/manager-heads'
import { useManagerHeadsEnabled } from '@/lib/manager-heads-pref'
import { isManagerPathname, projectsLabel } from '@/lib/managers'
import { cn } from '@/lib/utils'
import { ManagerAvatar } from '@/routes/manager/manager-avatar'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

/** Manager heads (design 2026-11 "Manager mode", section 3): a manager that needs you comes to the
 *  corner of task pages, speaks once, then rests until handled. */

export const HEAD_FOLD_MS = 8_000
const VISIBLE_HEADS = 2
const DOCK_GAP = 12
const EDGE = 16
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
/** The composer dock and, on a phone, the bottom bar and the floating New task button: the heads
 *  sit above whichever is highest, so the pill never covers the button. */
const ANCHORS = ['[data-slot="thread-dock"]', '[data-slot="phone-bottom-bar"]', '[data-slot="new-task-fab"]'] as const

interface Placement {
  dialogOpen: boolean
  /** px above the viewport bottom; null = no dock, use the 16px edge. */
  bottom: number | null
  right: number
}

const visible = (rect: DOMRect) => rect.width > 0 || rect.height > 0

function readPlacement(): Placement {
  const rects = ANCHORS.flatMap((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect()
    return rect && visible(rect) ? [{ selector, rect }] : []
  })
  const top = rects.length === 0 ? null : Math.min(...rects.map(({ rect }) => rect.top))
  const dock = rects.find(({ selector }) => selector === ANCHORS[0])?.rect
  return {
    dialogOpen: document.querySelector(OPEN_DIALOG) !== null,
    bottom: top === null ? null : Math.round(window.innerHeight - top + DOCK_GAP),
    // The dock spans the main pane, so its right edge is the content area's.
    right: dock ? Math.max(EDGE, Math.round(window.innerWidth - dock.right + EDGE)) : EDGE,
  }
}

const samePlacement = (a: Placement, b: Placement) => a.dialogOpen === b.dialogOpen && a.bottom === b.bottom && a.right === b.right

/** Dialogs portal in and the dock mounts with its route, so one observer watches for both. */
function usePlacement(active: boolean): Placement {
  const [placement, setPlacement] = useState<Placement>({ dialogOpen: false, bottom: null, right: EDGE })
  useEffect(() => {
    if (!active) return undefined
    let observed: Element[] = []
    const update = () => {
      const next = readPlacement()
      setPlacement((current) => (samePlacement(current, next) ? current : next))
      const anchors = ANCHORS.flatMap((selector) => {
        const element = document.querySelector(selector)
        return element ? [element] : []
      })
      if (anchors.length !== observed.length || anchors.some((element, index) => element !== observed[index])) {
        resize.disconnect()
        anchors.forEach((element) => resize.observe(element))
        observed = anchors
      }
    }
    const resize = new ResizeObserver(update)
    update()
    const mutations = new MutationObserver(update)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
    window.addEventListener('resize', update)
    return () => {
      mutations.disconnect()
      resize.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [active])
  return placement
}

export function ManagerHeads(): JSX.Element | null {
  const { pathname } = useLocation()
  const available = useHealth().data?.capabilities.managers === true
  const enabled = useManagerHeadsEnabled()
  // The list the shell already fetches; the workspace stream keeps it current.
  const managers = useManagers(false).data?.managers
  const active = available && enabled && managers !== undefined && !isManagerPathname(pathname)
  const placement = usePlacement(active)
  if (!active || placement.dialogOpen) return null
  return <HeadsOverlay managers={managers} bottom={placement.bottom} right={placement.right} />
}

const chatPath = (manager: ManagerSummary, kind?: HeadKind) =>
  `/manager/${encodeURIComponent(manager.id)}${kind && needsYou(kind) ? '#needs-you' : ''}`
const edgeBottom = (bottom: number | null) => (bottom === null ? `calc(${EDGE}px + env(safe-area-inset-bottom, 0px))` : `${bottom}px`)

function HeadsOverlay({ managers, bottom, right }: { managers: readonly ManagerSummary[]; bottom: number | null; right: number }) {
  const [laterMarks, setLaterMarks] = useState<HeadMemory>(() => readHeadMemory(HEADS_LATER_KEY))
  const later = settleLater(laterMarks, managers)
  useEffect(() => {
    if (later === laterMarks) return
    setLaterMarks(later)
    writeHeadMemory(HEADS_LATER_KEY, later)
  }, [later, laterMarks])

  const heads = useMemo(() => restingHeads(managers, later), [managers, later])
  const [announcement, setAnnouncement] = useState('')
  const [arrival, setArrival] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [folded, setFolded] = useState<string | null>(null)

  // Runs only while shown: what arrived behind a dialog or in manager mode is still news after.
  useEffect(() => {
    const { arrivals, seen } = diffArrivals(readHeadMemory(HEADS_SEEN_KEY), managers, heads)
    writeHeadMemory(HEADS_SEEN_KEY, seen)
    if (arrivals.length === 0) return
    setAnnouncement(arrivals.map((head) => headAnnouncement(head.manager, head.kind)).join(' '))
    const speaking = arrivals.filter((head) => needsYou(head.kind)).at(-1)
    if (speaking) {
      setArrival(speaking.manager.id)
      setFolded(null)
    }
  }, [managers, heads])

  useEffect(() => {
    if (arrival === null) return undefined
    const timer = setTimeout(() => setArrival(null), HEAD_FOLD_MS)
    return () => clearTimeout(timer)
  }, [arrival])

  const dismiss = useCallback((manager: ManagerSummary) => {
    const next = { ...later, [manager.id]: headCount(manager) }
    setLaterMarks(next)
    writeHeadMemory(HEADS_LATER_KEY, next)
    setArrival((current) => (current === manager.id ? null : current))
  }, [later])

  const newest = useRef<HTMLAnchorElement>(null)
  const pill = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // By code: ⌥M types `µ` on a Mac.
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.code !== 'KeyM') return
      const target = newest.current && newest.current.checkVisibility?.() !== false ? newest.current : pill.current
      if (!target) return
      event.preventDefault()
      target.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const projects = useProjects().data?.projects
  const nameOf = useCallback((id: string) => projects?.find((project) => project.id === id)?.name, [projects])

  const shown = heads.slice(-VISIBLE_HEADS)
  const hiddenCount = heads.length - shown.length
  const open = [hover, focus, arrival].find((id) => id !== null && id !== folded) ?? null
  const last = heads.at(-1)

  return (
    <>
      <p aria-live="polite" data-slot="manager-heads-announcer" className="sr-only">{announcement}</p>
      {shown.length > 0 ? (
        <div
          data-slot="manager-heads"
          style={{ right: `calc(${right}px + env(safe-area-inset-right, 0px))`, bottom: edgeBottom(bottom) }}
          className="pointer-events-none fixed z-20 flex flex-col items-end gap-2 max-md:hidden"
        >
          {hiddenCount > 0 ? (
            <Link
              to="/manager"
              data-slot="manager-heads-more"
              aria-label={`${hiddenCount} more ${hiddenCount === 1 ? 'manager' : 'managers'} waiting`}
              className="pointer-events-auto rounded-full bg-card px-2 py-0.5 text-meta font-semibold text-muted-foreground shadow-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              +{hiddenCount}
            </Link>
          ) : null}
          {shown.map((head, index) => {
            const id = head.manager.id
            const isNewest = index === shown.length - 1
            return (
              <div
                key={id}
                data-slot="manager-head-row"
                data-manager-id={id}
                className="pointer-events-auto flex items-end gap-2.5"
                onMouseEnter={() => {
                  setHover(id)
                  setFolded(null)
                }}
                onMouseLeave={() => setHover((current) => (current === id ? null : current))}
                onFocus={() => setFocus(id)}
                onBlur={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  setFocus((current) => (current === id ? null : current))
                  setFolded((current) => (current === id ? null : current))
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  event.stopPropagation()
                  setArrival((current) => (current === id ? null : current))
                  setFolded(id)
                }}
              >
                {open === id ? (
                  <HeadBubble
                    head={head}
                    project={projectsLabel(head.manager.projects, nameOf)}
                    onDismiss={() => dismiss(head.manager)}
                  />
                ) : null}
                <HeadAvatar
                  head={head}
                  large={isNewest}
                  arriving={arrival === id}
                  onOpen={() => dismiss(head.manager)}
                  ref={isNewest ? newest : undefined}
                />
              </div>
            )
          })}
        </div>
      ) : null}
      {last ? (
        <Link
          ref={pill}
          to={chatPath(last.manager, last.kind)}
          data-slot="manager-head-pill"
          onClick={() => dismiss(last.manager)}
          style={{ bottom: edgeBottom(bottom) }}
          className="fixed left-1/2 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card py-1 pr-2.5 pl-1 text-label whitespace-nowrap shadow-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
        >
          <ManagerAvatar avatar={last.manager.avatar} mascot={last.manager.mascot} sizes="24px" className="size-6 rounded-full object-cover" />
          <span className="truncate">
            <span className="font-semibold">{last.manager.name}</span> {HEAD_KIND_PHRASE[last.kind]}
          </span>
          <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </Link>
      ) : null}
    </>
  )
}

function HeadAvatar({ head, large, arriving, onOpen, ref }: {
  head: Head
  large: boolean
  arriving: boolean
  onOpen: () => void
  ref?: Ref<HTMLAnchorElement> | undefined
}) {
  const { manager, kind } = head
  return (
    <Link
      ref={ref}
      to={chatPath(manager, kind)}
      onClick={onOpen}
      data-slot="manager-head"
      data-kind={kind}
      aria-label={`${manager.name} ${HEAD_KIND_PHRASE[kind]}`}
      className={cn(
        'relative block shrink-0 rounded-full bg-card p-0.5 shadow-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        large ? 'size-11' : 'size-9',
        arriving && 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500',
      )}
    >
      <ManagerAvatar
        avatar={manager.avatar}
        mascot={manager.mascot}
        sizes={large ? '40px' : '32px'}
        className={cn('rounded-full object-cover', large ? 'size-10' : 'size-8')}
      />
      <span
        aria-hidden="true"
        data-slot="manager-head-badge"
        className={cn('absolute -top-px -right-px size-3 rounded-full border-2 border-card', needsYou(kind) ? 'bg-info' : 'bg-violet')}
      />
    </Link>
  )
}

function HeadBubble({ head, project, onDismiss }: { head: Head; project: string; onDismiss: () => void }) {
  const { manager, kind } = head
  return (
    <div
      role="group"
      aria-label={`${manager.name}: ${HEAD_KIND_LABEL[kind]}`}
      data-slot="manager-head-bubble"
      className="grid w-[262px] gap-2 rounded-[12px_12px_4px_12px] border border-border bg-card px-3 py-2.5 shadow-md motion-safe:animate-in motion-safe:fade-in-0"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
        <span className="truncate text-label font-semibold text-foreground">{manager.name}</span>
        {project ? <span className="truncate">· {project}</span> : null}
        <span
          data-slot="manager-head-kind"
          className={cn(
            'ml-auto shrink-0 rounded-full px-[7px] py-px text-micro font-semibold',
            needsYou(kind) ? 'bg-info/10 text-info' : 'bg-violet/10 text-violet',
          )}
        >
          {HEAD_KIND_LABEL[kind]}
        </span>
      </div>
      <p data-slot="manager-head-line" className="line-clamp-2 text-label text-foreground">{headLine(manager, kind)}</p>
      <div className="flex items-center gap-1.5">
        <Button asChild size="sm">
          <Link to={chatPath(manager, kind)} onClick={onDismiss} data-slot="manager-head-open">Open chat</Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} data-slot="manager-head-later">Later</Button>
        <Kbd className="ml-auto">{formatChord('Alt+M')}</Kbd>
      </div>
    </div>
  )
}
