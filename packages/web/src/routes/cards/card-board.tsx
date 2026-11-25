import type { FrameworkFile } from '@open-mercato/cezar-api-client'
import { LayersIcon, PlusIcon, SearchIcon } from 'lucide-react'
import * as React from 'react'

import { stageNamesOf, useCardRecheckOnFocus, useFramework, useFrameworks } from '@/api/frameworks'
import { useRuns, useWorkspaceConfig } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Kbd } from '@/components/kbd'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import {
  cardNotStarted,
  cardHeadline,
  compareReady,
  dropRule,
  wantsRecheck,
  isCard,
  needsYou,
  reorderPatches,
  type CardColumnId,
  type CardRun,
  type DropOutcome,
  type StageNames,
} from '@/lib/cards'
import { Link, useNavigate } from '@/lib/project-router'
import { isEditableTarget } from '@/lib/use-command-shortcut'
import { PHONE_QUERY, useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { FrameworkChooser } from '../settings/framework-section'
import { boardColumns, frameworkSource, frameworkSourceLine } from './board-columns'
import { CardConfirmDialog, useCardActions } from './card-actions'
import { CardTileBody, useTasksLayout } from './card-bits'
import { MobileBoard } from './mobile-board'
import { NewCardDialog } from './new-card-dialog'

/**
 * The Tasks board (spec 2026-11-15-framework-board, mockup 1): framework cards only, one column
 * per stage between Backlog/Ready and Ship/Done. It reads the runs list the SSE stream keeps live
 * (no poll), and asks the framework's state again on focus only while a card waits at its gate.
 */

export { boardColumns, frameworkSourceLine, type BoardColumn } from './board-columns'

export function TasksBoardRoute({ layoutToggle }: { layoutToggle?: React.ReactNode }) {
  const runs = useRuns()
  const frameworks = useFrameworks()
  const activeId = frameworks.data?.active.id
  const active = useFramework(activeId)
  const config = useWorkspaceConfig()
  const navigate = useNavigate()
  const actions = useCardActions()
  const [newOpen, setNewOpen] = React.useState(false)
  // Below md the board is one column at a time (spec § Mobile board) — the cockpit's phone breakpoint.
  const phone = useMediaQuery(PHONE_QUERY)
  const [, setLayout] = useTasksLayout()

  const all = runs.data
  const cards = React.useMemo(() => (all ?? []).filter((run) => isCard(run) && !run.archived) as CardRun[], [all])
  const otherCount = React.useMemo(() => (all ?? []).filter((run) => !isCard(run) && !run.archived).length, [all])
  const names = React.useMemo(() => stageNamesOf(frameworks.data, activeId), [frameworks.data, activeId])
  const activeStages = React.useMemo(() => frameworks.data?.frameworks.find((f) => f.id === activeId)?.stages.map((s) => s.id) ?? [], [frameworks.data, activeId])
  const wip = React.useMemo(() => wipLimits(active.data?.framework), [active.data])
  const busy = (all ?? []).filter((run) => run.status === 'running').length
  const max = config.data?.resources.maxParallel
  const slots = max ? { busy, max } : undefined
  const readyAhead = cards.filter((run) => cardNotStarted(run) && !run.card.held).length

  useCardRecheckOnFocus(cards.some(wantsRecheck))

  const onDrop = React.useCallback(
    async (run: CardRun, outcome: DropOutcome, readyIndex?: number) => {
      const fail = (error: Error) => toast(error.message, { tone: 'danger' })
      switch (outcome.kind) {
        case 'noop':
          return
        case 'refuse':
          toast(outcome.reason)
          return
        case 'hold':
          await actions.patch(run.id, { held: outcome.held }).catch(fail)
          return
        case 'reorder': {
          const ready = cards.filter((c) => cardNotStarted(c) && !c.card.held).sort(compareReady)
          // Dropped on tile `readyIndex` = before it; a card moving down lands one slot earlier.
          const from = ready.findIndex((c) => c.id === run.id)
          const at = readyIndex === undefined ? ready.length : from !== -1 && from < readyIndex ? readyIndex - 1 : readyIndex
          for (const { runId, order } of reorderPatches(ready, run.id, at)) {
            await actions.patch(runId, { order }).catch(fail)
          }
          return
        }
        case 'approve':
          actions.setPending({ kind: 'approve', run, gate: outcome.gate })
          return
        case 'rerun':
          actions.setPending({ kind: 'rerun', run, fromStage: outcome.fromStage })
      }
    },
    [actions, cards],
  )

  if (runs.isPending || frameworks.isPending) {
    return (
      <BoardShell layoutToggle={layoutToggle}>
        <p className="p-5 text-label text-muted-foreground">Loading the board…</p>
      </BoardShell>
    )
  }
  if (frameworks.isError) {
    return (
      <BoardShell layoutToggle={layoutToggle}>
        <CenteredState icon={<LayersIcon />} heading="h2" tone="danger" title="The board did not load" subtitle={frameworks.error.message} />
      </BoardShell>
    )
  }

  const newCard = frameworks.data ? (
    <NewCardDialog
      open={newOpen}
      onOpenChange={setNewOpen}
      frameworks={frameworks.data.frameworks}
      activeFramework={frameworks.data.active.id}
      slots={slots}
      readyAhead={readyAhead}
    />
  ) : null

  if (cards.length === 0) {
    return (
      <BoardShell layoutToggle={layoutToggle}>
        <div data-slot="board-empty" className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 md:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">Choose a framework</h2>
              <p className="text-label text-muted-foreground">
                The board shows framework cards. No framework installed? Generic (Plan ⏸ → Build → Review) works on any repo.
              </p>
            </div>
            <Button type="button" onClick={() => setNewOpen(true)}>
              <PlusIcon aria-hidden="true" />
              New card
            </Button>
          </div>
          <FrameworkChooser embedded />
          {otherCount > 0 ? <p className="text-meta text-muted-foreground">+ {otherCount} other tasks stay in the List.</p> : null}
        </div>
        <NewCardShortcut onNew={() => setNewOpen(true)} />
        {newCard}
      </BoardShell>
    )
  }

  const confirm = (
    <CardConfirmDialog
      pending={actions.pending}
      names={names}
      localHandoff={actions.localHandoff}
      onCancel={() => actions.setPending(null)}
      onConfirm={actions.confirm}
    />
  )

  if (phone) {
    return (
      <BoardShell layoutToggle={layoutToggle} fill>
        <MobileBoard
          cards={cards}
          activeStages={activeStages}
          names={names}
          wip={wip}
          framework={frameworkSource(frameworks.data)}
          otherCount={otherCount}
          slots={slots}
          onMove={onDrop}
          onNew={() => setNewOpen(true)}
          onShowList={() => setLayout('list')}
        />
        <NewCardShortcut onNew={() => setNewOpen(true)} />
        {newCard}
        {confirm}
      </BoardShell>
    )
  }

  return (
    <BoardShell layoutToggle={layoutToggle}>
      <CardBoard
        cards={cards}
        activeStages={activeStages}
        names={names}
        wip={wip}
        frameworkLine={frameworkSourceLine(frameworks.data)}
        otherCount={otherCount}
        slots={slots}
        onDrop={onDrop}
        onOpen={(id) => navigate(`/cards/${id}`)}
        onNew={() => setNewOpen(true)}
      />
      {newCard}
      {confirm}
    </BoardShell>
  )
}

function wipLimits(fw: FrameworkFile | undefined): Map<string, number> {
  return new Map((fw?.stages ?? []).flatMap((s) => (s.wip ? [[s.id, s.wip] as const] : [])))
}

/** `fill`: the phone board takes exactly the scroller's height — its columns scroll, the page does not. */
function BoardShell({ layoutToggle, fill = false, children }: { layoutToggle?: React.ReactNode; fill?: boolean; children: React.ReactNode }) {
  return (
    <div data-route="tasks" data-layout="board" className={cn('flex flex-col', fill ? 'h-full min-h-0' : 'min-h-full')}>
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:h-14 md:px-5">
        <h1 className="hidden text-base font-semibold md:block">Tasks</h1>
        {layoutToggle}
      </header>
      <div className={cn('flex flex-1 flex-col', fill ? 'min-h-0' : 'pb-[env(safe-area-inset-bottom)]')}>{children}</div>
    </div>
  )
}

/** `N` opens New card — not while typing, not with a modifier (⌘N is New task), not over a dialog. */
function NewCardShortcut({ onNew }: { onNew: () => void }) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      if (isEditableTarget(event.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      onNew()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onNew])
  return null
}

/** Arrow keys move focus across the grid of tiles (column, row); Enter opens the focused card. */
function moveFocus(board: HTMLElement, from: HTMLElement, key: string): boolean {
  const columns = [...board.querySelectorAll<HTMLElement>('[data-slot="board-column"]')].map((col) => [...col.querySelectorAll<HTMLElement>('[data-slot="card-tile"]')])
  const c = columns.findIndex((tiles) => tiles.includes(from))
  if (c === -1) return false
  const r = columns[c]!.indexOf(from)
  let target: HTMLElement | undefined
  if (key === 'ArrowDown') target = columns[c]![r + 1]
  else if (key === 'ArrowUp') target = columns[c]![r - 1]
  else {
    const step = key === 'ArrowRight' ? 1 : -1
    for (let i = c + step; i >= 0 && i < columns.length; i += step) {
      if (columns[i]!.length) {
        target = columns[i]![Math.min(r, columns[i]!.length - 1)]
        break
      }
    }
  }
  target?.focus()
  return Boolean(target)
}

export function CardBoard({
  cards,
  activeStages,
  names,
  wip,
  frameworkLine,
  otherCount,
  slots,
  onDrop,
  onOpen,
  onNew,
}: {
  cards: readonly CardRun[]
  activeStages: readonly string[]
  names?: StageNames
  wip?: ReadonlyMap<string, number>
  frameworkLine: string
  otherCount: number
  slots?: { busy: number; max: number }
  onDrop: (run: CardRun, outcome: DropOutcome, readyIndex?: number) => void
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const [filter, setFilter] = React.useState('')
  const [dragging, setDragging] = React.useState<CardRun | null>(null)
  const [over, setOver] = React.useState<CardColumnId | null>(null)
  const boardRef = React.useRef<HTMLDivElement>(null)
  const needle = filter.trim().toLowerCase()
  const shown = needle ? cards.filter((run) => run.card.title.toLowerCase().includes(needle) || run.card.issue?.ref.toLowerCase().includes(needle)) : cards
  const columns = boardColumns(shown, activeStages, names, wip)
  const needYou = cards.filter(needsYou).length

  const drop = (column: CardColumnId, readyIndex?: number) => {
    const run = dragging
    setDragging(null)
    setOver(null)
    if (!run) return
    onDrop(run, dropRule(run, column, names), readyIndex)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NewCardShortcut onNew={onNew} />
      <div data-slot="board-header" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2.5 md:px-5">
        <span className="inline-flex items-center gap-1.5 text-label font-semibold text-foreground">
          <span className="text-violet" aria-hidden="true">◆</span>
          <span data-slot="board-framework">{frameworkLine}</span>
          <Link to="/settings/framework" className="font-normal text-primary hover:underline">
            Change
          </Link>
        </span>
        {slots ? (
          <span data-slot="board-slots" title="Ready cards start in order whenever an agent slot frees" className="rounded-full bg-muted px-2 py-0.5 text-meta text-muted-foreground">
            Autopick on · {slots.busy}/{slots.max} slots
          </span>
        ) : null}
        {otherCount > 0 ? <span data-slot="board-other" className="text-meta text-muted-foreground">+ {otherCount} other tasks · in the List</span> : null}
        {needYou > 0 ? (
          <span data-slot="board-need-you" className="rounded-full bg-pending/15 px-2 py-0.5 text-meta font-medium text-pending-strong">
            ⏸ {needYou} need you
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-soft-foreground" aria-hidden="true" />
          <input
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter cards…"
            aria-label="Filter cards"
            className="h-8 w-44 rounded-md border border-input bg-card pr-2 pl-7 text-ui outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </span>
        <Button type="button" size="sm" data-action="new-card" onClick={onNew}>
          <PlusIcon aria-hidden="true" />
          New card <Kbd>N</Kbd>
        </Button>
      </div>
      <div
        ref={boardRef}
        data-slot="card-board"
        role="grid"
        aria-label="Framework board"
        onKeyDown={(event) => {
          const tile = (event.target as HTMLElement).closest<HTMLElement>('[data-slot="card-tile"]')
          if (!tile || !boardRef.current) return
          if (event.key === 'Enter') {
            event.preventDefault()
            onOpen(tile.dataset.runId!)
          } else if (event.key.startsWith('Arrow') && moveFocus(boardRef.current, tile, event.key)) {
            event.preventDefault()
          }
        }}
        className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:p-5"
      >
        {columns.map((column) => (
          <section
            key={column.id}
            data-slot="board-column"
            data-column={column.id}
            data-over={over === column.id || undefined}
            role="row"
            aria-label={column.title}
            onDragOver={(event) => {
              if (!dragging) return
              event.preventDefault()
              if (over !== column.id) setOver(column.id)
            }}
            onDragLeave={(event) => {
              if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver(null)
            }}
            onDrop={(event) => {
              event.preventDefault()
              drop(column.id, column.id === 'ready' ? column.cards.length : undefined)
            }}
            className={cn(
              'flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2',
              over === column.id && 'border-primary/60 bg-primary/5',
            )}
          >
            <header className="flex items-center gap-1.5 px-1 text-label">
              {column.index ? <span className="font-mono text-meta text-soft-foreground">{column.index}</span> : null}
              <span className="font-semibold text-foreground">{column.title}</span>
              <span data-slot="column-count" className="font-mono text-meta text-muted-foreground tabular-nums">
                {column.cards.length}
              </span>
              {column.wip ? (
                <span className={cn('ml-auto rounded-full px-1.5 text-micro', column.cards.length >= column.wip ? 'bg-pending/15 text-pending-strong' : 'bg-muted text-muted-foreground')}>
                  WIP {column.cards.length}/{column.wip}
                </span>
              ) : null}
              {column.id === 'ready' ? <span className="ml-auto text-micro text-soft-foreground">pickup ↓</span> : null}
              {column.id === 'ship' ? <span className="ml-auto text-micro text-soft-foreground">human merges</span> : null}
            </header>
            {column.cards.map((run, i) => (
              <CardTile
                key={run.id}
                run={run}
                names={names}
                note={column.id === 'ready' ? (i === 0 ? 'next up' : `#${i + 1} in queue`) : undefined}
                onOpen={() => onOpen(run.id)}
                onDragStart={() => setDragging(run)}
                onDragEnd={() => {
                  setDragging(null)
                  setOver(null)
                }}
                onDropBefore={
                  column.id === 'ready'
                    ? () => {
                        drop('ready', i)
                      }
                    : undefined
                }
              />
            ))}
            {column.id === 'ready' && column.cards.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-2 py-3 text-center text-meta text-soft-foreground">Drop here to let an agent start it</p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  )
}

function CardTile({
  run,
  names,
  note,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropBefore,
}: {
  run: CardRun
  names?: StageNames
  note?: string
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDropBefore?: () => void
}) {
  const waiting = needsYou(run)
  return (
    <div
      data-slot="card-tile"
      data-run-id={run.id}
      role="gridcell"
      tabIndex={0}
      draggable
      aria-label={`${run.card.title} — ${cardHeadline(run, names)}`}
      onDragStart={(event) => {
        event.dataTransfer?.setData('text/plain', run.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDrop={
        onDropBefore
          ? (event) => {
              event.preventDefault()
              event.stopPropagation()
              onDropBefore()
            }
          : undefined
      }
      onClick={onOpen}
      className={cn(
        'cursor-pointer rounded-md border bg-card px-2.5 py-2 shadow-xs outline-none hover:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        waiting ? 'border-pending/60' : 'border-border',
      )}
    >
      <CardTileBody run={run} names={names} note={note} />
    </div>
  )
}
