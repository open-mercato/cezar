import type { FrameworksResponse } from '@open-mercato/cezar-api-client'

import { boardStages, cardsByColumn, needsYou, stageColumn, stageName, type CardColumnId, type CardRun, type StageNames } from '@/lib/cards'

/** The board's column model, shared by the desktop kanban and the phone board (spec 2026-11-15-framework-board). */

const NO_CARDS: CardRun[] = []

export interface BoardColumn {
  id: CardColumnId
  title: string
  /** 1-based stage number, for stage columns. */
  index?: number
  wip?: number
  cards: CardRun[]
}

/** The columns, in board order: Backlog, Ready, each stage, Ship, Done. */
export function boardColumns(cards: readonly CardRun[], activeStages: readonly string[], names?: StageNames, wip?: ReadonlyMap<string, number>): BoardColumn[] {
  const byColumn = cardsByColumn(cards)
  const stages = boardStages(activeStages, cards)
  return [
    { id: 'backlog', title: 'Backlog', cards: byColumn.get('backlog') ?? NO_CARDS },
    { id: 'ready', title: 'Ready', cards: byColumn.get('ready') ?? NO_CARDS },
    ...stages.map((stage, i) => ({
      id: stageColumn(stage),
      title: stageName(names, stage),
      index: i + 1,
      ...(wip?.get(stage) ? { wip: wip.get(stage) } : {}),
      cards: byColumn.get(stageColumn(stage)) ?? NO_CARDS,
    })),
    { id: 'ship', title: 'Ship', cards: byColumn.get('ship') ?? NO_CARDS },
    { id: 'done', title: 'Done', cards: byColumn.get('done') ?? NO_CARDS },
  ]
}

/** The phone board's first column: where a card needs you, else the first busy stage, else Ready. */
export function defaultBoardColumn(columns: readonly BoardColumn[]): CardColumnId {
  return (
    columns.find((c) => c.cards.some(needsYou))?.id ??
    columns.find((c) => c.id.startsWith('stage:') && c.cards.length > 0)?.id ??
    'ready'
  )
}

/** Where the board's framework came from (D6), as name and source. */
export function frameworkSource(data: FrameworksResponse | undefined): { name: string; source: string } | undefined {
  if (!data) return undefined
  const { active } = data
  const name = data.frameworks.find((f) => f.id === active.id)?.name ?? active.id
  const source = active.source === 'detected' ? `detected (${active.detectedBy ?? 'repo'})` : active.source === 'explicit' ? 'chosen' : 'automatic'
  return { name, source }
}

/** "Open Mercato SDD · detected (.ai/sdd/sdd.mjs)". */
export function frameworkSourceLine(data: FrameworksResponse | undefined): string {
  const fw = frameworkSource(data)
  return fw ? `${fw.name} · ${fw.source}` : ''
}
