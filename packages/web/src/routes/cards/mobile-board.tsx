import { ArrowLeftIcon, ChevronRightIcon, EllipsisIcon, PlusIcon, SearchIcon } from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cardHeadline, cardMoves, needsYou, type CardColumnId, type CardMove, type CardRun, type DropOutcome, type StageNames } from '@/lib/cards'
import { Link, useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { boardColumns, defaultBoardColumn, type BoardColumn } from './board-columns'
import { CardTileBody } from './card-bits'
import { runRoute } from '@/lib/task-route'

/**
 * The board on a phone (spec 2026-11-15-framework-board § Mobile board): one column at a time
 * behind a tab strip, swiped through a scroll-snap pager, and an action sheet in place of drag —
 * its moves are `cardMoves`, i.e. the desktop drop rules asked one target at a time.
 */

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const EMPTY_LINE: Record<string, string> = {
  backlog: 'Drafts wait here until you move them to Ready.',
  ready: 'Cards here start when a slot frees up.',
  ship: 'Cards land here after their last stage — a person merges them.',
  done: 'Merged and cancelled cards end up here.',
}

function emptyLine(column: BoardColumn, filtered: boolean): string {
  if (filtered) return 'No card here matches the filter.'
  return EMPTY_LINE[column.id] ?? `No card is in ${column.title} right now.`
}

/** "Build, 2 of 2 WIP, full, 1 needs you" — the chip's name, so the dot is never color alone. */
function chipLabel(column: BoardColumn, total: number, needYou: number): string {
  const parts = [column.title, column.wip ? `${total} of ${column.wip} WIP${total >= column.wip ? ', full' : ''}` : `${column.cards.length} ${column.cards.length === 1 ? 'card' : 'cards'}`]
  if (needYou > 0) parts.push(`${needYou} ${needYou === 1 ? 'needs' : 'need'} you`)
  return parts.join(', ')
}

export function MobileBoard({
  cards,
  activeStages,
  names,
  wip,
  framework,
  otherCount,
  slots,
  onMove,
  onNew,
  onShowList,
}: {
  cards: readonly CardRun[]
  activeStages: readonly string[]
  names?: StageNames
  wip?: ReadonlyMap<string, number>
  framework?: { name: string; source: string }
  otherCount: number
  slots?: { busy: number; max: number }
  /** The desktop drop handler: a sheet move is the drop it replaces. */
  onMove: (run: CardRun, outcome: DropOutcome, readyIndex?: number) => void
  onNew: () => void
  onShowList: () => void
}) {
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = React.useState('')
  const [filterOpen, setFilterOpen] = React.useState(false)
  const [needOnly, setNeedOnly] = React.useState(false)
  const [sheetFor, setSheetFor] = React.useState<string | null>(null)
  const filterRef = React.useRef<HTMLInputElement>(null)

  const needYou = cards.filter(needsYou).length
  const needle = filter.trim().toLowerCase()
  const filtered = needle !== '' || needOnly
  const matches = (run: CardRun) =>
    (!needOnly || needsYou(run)) && (!needle || run.card.title.toLowerCase().includes(needle) || Boolean(run.card.issue?.ref.toLowerCase().includes(needle)))
  // Built from every card, then filtered, so a filter never removes a column under the strip.
  const all = boardColumns(cards, activeStages, names, wip)
  const columns = filtered ? all.map((c) => ({ ...c, cards: c.cards.filter(matches) })) : all
  const ready = all.find((c) => c.id === 'ready')?.cards ?? []

  const asked = params.get('col')
  const known = asked !== null && columns.some((c) => c.id === asked)
  const active: CardColumnId = known ? (asked as CardColumnId) : defaultBoardColumn(all)
  const index = Math.max(0, columns.findIndex((c) => c.id === active))

  const select = React.useCallback(
    (id: CardColumnId) =>
      setParams(
        (current) => {
          const out = new URLSearchParams(current)
          out.set('col', id)
          return out
        },
        { replace: true },
      ),
    [setParams],
  )

  // Pin the chosen first column, so a card that stops needing you does not move the board.
  React.useEffect(() => {
    if (!known) select(active)
  }, [known, active, select])

  // ── The pager: scroll position ⇄ active column ──────────────────────────────
  const pagerRef = React.useRef<HTMLDivElement>(null)
  const stripRef = React.useRef<HTMLDivElement>(null)
  /** A chip tap's smooth scroll in flight: pages it passes are not selections. */
  const target = React.useRef<number | null>(null)
  /** The index the last swipe selected — that one is already where the pager is. */
  const swiped = React.useRef<number | null>(null)
  const frame = React.useRef(0)
  const settle = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const scrollToIndex = React.useCallback((i: number, smooth: boolean) => {
    const pager = pagerRef.current
    if (!pager) return
    const left = i * pager.clientWidth
    if (Math.abs(pager.scrollLeft - left) < 1) return
    const animate = smooth && !reducedMotion()
    target.current = animate ? i : null
    clearTimeout(settle.current)
    if (animate) settle.current = setTimeout(() => (target.current = null), 1000)
    if (typeof pager.scrollTo === 'function') pager.scrollTo({ left, behavior: animate ? 'smooth' : 'auto' })
    else pager.scrollLeft = left
  }, [])

  React.useLayoutEffect(() => {
    if (swiped.current === index || target.current === index) return
    scrollToIndex(index, false)
  }, [index, scrollToIndex])

  React.useEffect(() => () => {
    cancelAnimationFrame(frame.current)
    clearTimeout(settle.current)
  }, [])

  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const pager = pagerRef.current
      if (!pager || !pager.clientWidth) return
      const i = Math.min(columns.length - 1, Math.max(0, Math.round(pager.scrollLeft / pager.clientWidth)))
      if (target.current !== null) {
        if (i !== target.current) return
        target.current = null
      }
      if (i !== index) {
        swiped.current = i
        select(columns[i]!.id)
      }
    })
  }

  // The active chip stays in view (its own row's scroll only — never the page's).
  React.useEffect(() => {
    const strip = stripRef.current
    const chip = strip?.querySelectorAll<HTMLElement>('[role="tab"]')[index]
    if (!strip || !chip) return
    const left = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2
    if (typeof strip.scrollTo === 'function') strip.scrollTo({ left, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [index])

  const go = (i: number, focus = false) => {
    const column = columns[i]
    if (!column) return
    swiped.current = null
    scrollToIndex(i, true)
    select(column.id)
    if (focus) stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus()
  }

  const onStripKey = (event: React.KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: columns.length - 1 }
    const next = keys[event.key]
    if (next === undefined || next < 0 || next >= columns.length) return
    event.preventDefault()
    go(next, true)
  }

  const sheetRun = sheetFor ? cards.find((c) => c.id === sheetFor) : undefined

  return (
    <div data-slot="mobile-board" className="flex min-h-0 flex-1 flex-col">
      <div data-slot="board-header" className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-violet" aria-hidden="true">◆</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span data-slot="board-framework" className="truncate text-label font-semibold text-foreground">{framework?.name ?? 'Board'}</span>
            {framework ? <span className="truncate text-micro text-muted-foreground">{framework.source}</span> : null}
          </span>
          {needYou > 0 ? (
            <button
              type="button"
              data-slot="board-need-you"
              aria-pressed={needOnly}
              onClick={() => setNeedOnly((on) => !on)}
              className={cn(
                'inline-flex h-8 shrink-0 items-center rounded-full border px-2.5 text-meta font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11',
                needOnly ? 'border-pending bg-pending/25 text-pending-strong' : 'border-transparent bg-pending/15 text-pending-strong',
              )}
            >
              ⏸ {needYou} need you
            </button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Board options" className="shrink-0 pointer-coarse:size-11">
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {slots ? (
                <DropdownMenuLabel data-slot="board-slots" className="font-normal text-muted-foreground">
                  Autopick · {slots.busy}/{slots.max} slots busy
                </DropdownMenuLabel>
              ) : null}
              <DropdownMenuItem asChild>
                <Link to="/settings/framework">Change framework</Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setFilterOpen(true)
                  // After the menu returns focus to its trigger.
                  setTimeout(() => filterRef.current?.focus(), 0)
                }}
              >
                Filter cards
              </DropdownMenuItem>
              {otherCount > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem data-slot="board-other" onSelect={onShowList}>
                    + {otherCount} other {otherCount === 1 ? 'task' : 'tasks'} · in the List
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {filterOpen || filter ? (
          <span className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-soft-foreground" aria-hidden="true" />
            <input
              ref={filterRef}
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onBlur={() => setFilterOpen(false)}
              placeholder="Filter cards…"
              aria-label="Filter cards"
              className="h-10 w-full rounded-md border border-input bg-card pr-2 pl-8 text-ui outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </span>
        ) : null}
      </div>

      <div
        ref={stripRef}
        role="tablist"
        aria-label="Board columns"
        data-slot="board-tabs"
        onKeyDown={onStripKey}
        className="flex shrink-0 gap-1.5 overflow-x-auto overscroll-x-contain border-b border-border bg-background px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {columns.map((column, i) => {
          const selected = i === index
          const total = all[i]!.cards.length
          const full = column.wip !== undefined && total >= column.wip
          const waiting = column.cards.filter(needsYou).length
          return (
            <button
              key={column.id}
              type="button"
              role="tab"
              id={`board-tab-${column.id}`}
              data-column={column.id}
              aria-selected={selected}
              aria-controls={`board-panel-${column.id}`}
              aria-label={chipLabel(column, total, waiting)}
              tabIndex={selected ? 0 : -1}
              onClick={() => go(i)}
              className={cn(
                'relative inline-flex h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-label font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11',
                selected ? 'border-contrast bg-contrast text-contrast-foreground' : 'border-border bg-card text-muted-foreground',
                full && !selected && 'border-pending/60 bg-pending/15 text-pending-strong',
              )}
            >
              {column.title}
              <span aria-hidden="true" className="font-mono tabular-nums opacity-80">
                · {column.wip ? `${total}/${column.wip}` : column.cards.length}
              </span>
              {waiting > 0 ? <span data-slot="tab-needs-you" aria-hidden="true" className="ml-0.5 size-2 rounded-full bg-pending" /> : null}
            </button>
          )
        })}
      </div>

      <div
        ref={pagerRef}
        data-slot="board-pager"
        onScroll={onScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {columns.map((column, i) => {
          const selected = i === index
          return (
            <section
              key={column.id}
              role="tabpanel"
              id={`board-panel-${column.id}`}
              data-slot="board-panel"
              data-column={column.id}
              aria-labelledby={`board-tab-${column.id}`}
              aria-hidden={selected ? undefined : true}
              inert={!selected}
              className="flex w-full shrink-0 snap-start snap-always flex-col gap-2 overflow-y-auto overscroll-y-contain px-3 pt-3 pb-24"
            >
              {column.id === 'ship' ? <p className="text-meta text-muted-foreground">A person merges what lands here.</p> : null}
              {column.cards.length === 0 ? (
                <p data-slot="column-empty" className="rounded-md border border-dashed border-border px-3 py-6 text-center text-label text-muted-foreground">
                  {emptyLine(column, filtered)}
                </p>
              ) : (
                column.cards.map((run, at) => (
                  <MobileTile
                    key={run.id}
                    run={run}
                    names={names}
                    note={column.id === 'ready' ? (at === 0 ? 'next up' : `#${at + 1} in queue`) : undefined}
                    onActions={() => setSheetFor(run.id)}
                  />
                ))
              )}
            </section>
          )
        })}
      </div>

      <button
        type="button"
        data-slot="new-card-fab"
        aria-label="New card"
        onClick={onNew}
        className="fixed right-4 bottom-[calc(16px+var(--phone-bar,0px)+env(safe-area-inset-bottom))] z-20 inline-flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-modal outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
      >
        <PlusIcon className="size-[22px]" aria-hidden="true" />
      </button>

      <CardActionSheet
        run={sheetRun}
        names={names}
        moves={sheetRun ? cardMoves(sheetRun, { names, ready }) : []}
        onClose={() => setSheetFor(null)}
        onMove={(move) => {
          if (!sheetRun) return
          setSheetFor(null)
          onMove(sheetRun, move.outcome, move.readyIndex)
        }}
      />
    </div>
  )
}

function MobileTile({ run, names, note, onActions }: { run: CardRun; names?: StageNames; note?: string; onActions: () => void }) {
  return (
    <div
      data-slot="card-tile"
      data-run-id={run.id}
      className={cn('flex items-start rounded-md border bg-card shadow-xs', needsYou(run) ? 'border-pending/60' : 'border-border')}
    >
      <Link
        to={`/cards/${run.id}`}
        aria-label={`${run.card.title} — ${cardHeadline(run, names)}`}
        className="block min-h-11 min-w-0 flex-1 rounded-md py-2.5 pl-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <CardTileBody run={run} names={names} note={note} phone />
      </Link>
      <button
        type="button"
        aria-label={`Card actions for ${run.card.title}`}
        aria-haspopup="dialog"
        onClick={onActions}
        className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <EllipsisIcon className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

const SHEET_ROW =
  'flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-ui text-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent'

/** A move row. Refused moves stay focusable (`aria-disabled`) so the reason is reachable and read. */
function MoveRow({ label, reason, onPick, trailing, move }: { label: string; reason?: string; onPick: () => void; trailing?: React.ReactNode; move: string }) {
  const reasonId = React.useId()
  return (
    <button
      type="button"
      data-move={move}
      aria-disabled={reason ? true : undefined}
      aria-describedby={reason ? reasonId : undefined}
      onClick={reason ? undefined : onPick}
      className={SHEET_ROW}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(reason && 'text-muted-foreground')}>{label}</span>
        {reason ? (
          // aria-hidden keeps it out of the name; `aria-describedby` still reads it.
          <span id={reasonId} aria-hidden="true" data-slot="move-reason" className="text-meta text-muted-foreground">
            {reason}
          </span>
        ) : null}
      </span>
      {trailing}
    </button>
  )
}

function CardActionSheet({
  run,
  names,
  moves,
  onClose,
  onMove,
}: {
  run: CardRun | undefined
  names?: StageNames
  moves: CardMove[]
  onClose: () => void
  onMove: (move: CardMove) => void
}) {
  const [view, setView] = React.useState<'main' | 'rerun'>('main')
  const navigate = useNavigate()
  React.useEffect(() => {
    if (!run) setView('main')
  }, [run])
  const reruns = moves.filter((m) => m.id.startsWith('rerun:'))
  const others = moves.filter((m) => !m.id.startsWith('rerun:'))
  const rerunOpen = reruns.some((m) => !m.reason)
  const open = (to: string) => {
    onClose()
    navigate(to)
  }
  return (
    <Sheet open={run !== undefined} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="bottom" data-slot="card-action-sheet" className="max-h-[85dvh] gap-1 overflow-y-auto rounded-t-2xl px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="px-1 pb-2">
          <SheetTitle className="line-clamp-2 text-ui">{run?.card.title}</SheetTitle>
          <SheetDescription className="text-meta">{run ? cardHeadline(run, names) : ''}</SheetDescription>
        </SheetHeader>
        {view === 'rerun' ? (
          <div role="group" aria-label="Re-run from a stage" className="flex flex-col">
            <button type="button" onClick={() => setView('main')} className={cn(SHEET_ROW, 'text-muted-foreground')}>
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              Back
            </button>
            {reruns.map((move) => (
              <MoveRow key={move.id} move={move.id} label={move.label} reason={move.reason} onPick={() => onMove(move)} />
            ))}
          </div>
        ) : (
          <div role="group" aria-label="Move card" className="flex flex-col">
            {others.map((move) => (
              <MoveRow key={move.id} move={move.id} label={move.label} reason={move.reason} onPick={() => onMove(move)} />
            ))}
            {reruns.length > 0 ? (
              <MoveRow
                move="rerun"
                label="Re-run from…"
                reason={rerunOpen ? undefined : reruns[0]!.reason}
                onPick={() => setView('rerun')}
                trailing={rerunOpen ? <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" /> : null}
              />
            ) : null}
            {moves.length > 0 ? <div role="separator" className="my-1 h-px bg-border" /> : null}
            {run ? (
              <>
                <button type="button" data-move="open-card" className={SHEET_ROW} onClick={() => open(`/cards/${run.id}`)}>
                  Open card
                </button>
                <button type="button" data-move="open-task" className={SHEET_ROW} onClick={() => open(runRoute(run, { taskView: true }))}>
                  Open task view
                </button>
              </>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
