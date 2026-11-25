import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cardAtGate, cardRun, HUMAN_ASK } from '@/lib/card-fixtures'
import type { CardRun, DropOutcome } from '@/lib/cards'
import { boardColumns, CardBoard, frameworkSourceLine } from './card-board'

/** The framework board (spec 2026-11-15-framework-board, mockup 1). */

afterEach(cleanup)

const NAMES = new Map([
  ['plan', 'Plan'],
  ['build', 'Build'],
  ['review', 'Review'],
])

function board(cards: CardRun[], onDrop = vi.fn<(run: CardRun, outcome: DropOutcome, index?: number) => void>(), onNew = vi.fn(), onOpen = vi.fn()) {
  render(
    <MemoryRouter>
      <CardBoard
        cards={cards}
        activeStages={['plan', 'build', 'review']}
        names={NAMES}
        wip={new Map([['build', 2]])}
        frameworkLine="Generic · automatic"
        otherCount={4}
        slots={{ busy: 1, max: 4 }}
        onDrop={onDrop}
        onOpen={onOpen}
        onNew={onNew}
      />
    </MemoryRouter>,
  )
  return { onDrop, onNew, onOpen }
}

const column = (id: string) => document.querySelector(`[data-slot="board-column"][data-column="${id}"]`) as HTMLElement
const tile = (id: string) => document.querySelector(`[data-slot="card-tile"][data-run-id="${id}"]`) as HTMLElement

describe('card board', () => {
  it('builds its columns from the framework’s stages, between Backlog/Ready and Ship/Done', () => {
    const cards = [
      cardRun({ id: 'h', status: 'queued' }, { held: true }),
      cardRun({ id: 'r', status: 'queued' }),
      cardRun({ id: 'p' }),
      cardRun({ id: 's', status: 'review' }),
      cardRun({ id: 'old' }, { stageOrder: ['plan', 'build', 'review', 'archive'], stage: 'archive' }),
    ]
    expect(boardColumns(cards, ['plan', 'build', 'review'], NAMES).map((c) => [c.id, c.cards.map((x) => x.id)])).toEqual([
      ['backlog', ['h']],
      ['ready', ['r']],
      ['stage:plan', ['p']],
      ['stage:build', []],
      ['stage:review', []],
      ['stage:archive', ['old']],
      ['ship', ['s']],
      ['done', []],
    ])

    board(cards)
    const titles = [...document.querySelectorAll('[data-slot="board-column"]')].map((c) => c.getAttribute('aria-label'))
    expect(titles).toEqual(['Backlog', 'Ready', 'Plan', 'Build', 'Review', 'Archive', 'Ship', 'Done'])
    expect(column('stage:build').textContent).toContain('WIP 0/2')
    expect(screen.getByText('Autopick on · 1/4 slots')).toBeTruthy()
    expect(screen.getByText('+ 4 other tasks · in the List')).toBeTruthy()
  })

  it('says where the framework came from (D6)', () => {
    expect(
      frameworkSourceLine({
        frameworks: [{ id: 'open-mercato-sdd', name: 'Open Mercato SDD', source: 'builtin', stages: [] }],
        active: { id: 'open-mercato-sdd', source: 'detected', detectedBy: '.ai/sdd/sdd.mjs' },
      }),
    ).toBe('Open Mercato SDD · detected (.ai/sdd/sdd.mjs)')
  })

  it('counts the cards that need a person', () => {
    board([cardAtGate('plan', { id: 'g', asks: [HUMAN_ASK] }), cardRun({ id: 'x' })])
    expect(screen.getByText('⏸ 1 need you')).toBeTruthy()
    expect(within(tile('g')).getByText('⏸ approve plan')).toBeTruthy()
  })

  it('hands a refused drop its reason, and an accepted one its action', () => {
    const { onDrop } = board([cardRun({ id: 'run' }), cardAtGate('plan', { id: 'gate', asks: [HUMAN_ASK] }), cardRun({ id: 'h', status: 'queued' }, { held: true })])

    fireEvent.dragStart(tile('run'))
    fireEvent.dragOver(column('stage:build'))
    fireEvent.drop(column('stage:build'))
    expect(onDrop.mock.calls[0]![1]).toEqual({
      kind: 'refuse',
      reason: 'A card moves forward only by approving an open gate — this one is not waiting at one.',
    })

    fireEvent.dragStart(tile('gate'))
    fireEvent.drop(column('stage:build'))
    expect(onDrop.mock.calls[1]![1]).toMatchObject({ kind: 'approve', to: 'build' })

    fireEvent.dragStart(tile('h'))
    fireEvent.drop(column('ready'))
    expect(onDrop.mock.calls[2]![1]).toEqual({ kind: 'hold', held: false })
  })

  it('moves focus with the arrow keys, opens with Enter, and opens New card with N', () => {
    const { onOpen, onNew } = board([cardRun({ id: 'a' }), cardRun({ id: 'b' }), cardRun({ id: 'c' }, { stage: 'build' })])
    tile('a').focus()
    fireEvent.keyDown(tile('a'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(tile('b'))
    fireEvent.keyDown(tile('b'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tile('c'))
    fireEvent.keyDown(tile('c'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('c')

    fireEvent.keyDown(window, { key: 'n' })
    expect(onNew).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'n', metaKey: true })
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})
