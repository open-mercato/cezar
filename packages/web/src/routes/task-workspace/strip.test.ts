import { describe, expect, it } from 'vitest'

import { FIXED_VIEW_ORDER } from './layout-state'
import { stripEntries, stripGroups, stripTabs } from './strip'

describe('stripTabs — where Notes lands', () => {
  it('after Graph, in the run group, when the row has one', () => {
    expect(stripTabs(FIXED_VIEW_ORDER)).toEqual(['session', 'changes', 'commits', 'files', 'browser', 'graph', 'notes', 'assets', 'terminal'])
  })

  it('before Assets or Terminal without a Graph, else last', () => {
    expect(stripTabs(['session', 'changes', 'commits', 'files', 'browser', 'assets', 'terminal'])).toEqual([
      'session', 'changes', 'commits', 'files', 'browser', 'notes', 'assets', 'terminal',
    ])
    expect(stripTabs(['session', 'changes', 'terminal'])).toEqual(['session', 'changes', 'notes', 'terminal'])
    expect(stripTabs(['session', 'changes'])).toEqual(['session', 'changes', 'notes'])
  })

  it('numbers the tabs in that order — the number on a tab is the key that opens it', () => {
    expect(stripEntries(['session', 'changes', 'browser', 'graph']).map((entry) => entry.id)).toEqual([
      'view:session', 'view:changes', 'view:browser', 'view:graph', 'view:notes',
    ])
  })
})

describe('stripGroups — Chat | the review | the run', () => {
  it('cuts the full row into its three groups, every tab kept in place', () => {
    expect(stripGroups(stripTabs(FIXED_VIEW_ORDER))).toEqual([
      ['session'],
      ['changes', 'commits', 'files', 'browser'],
      ['graph', 'notes', 'assets', 'terminal'],
    ])
  })

  it('drops a group nothing fell into, and never moves a tab across a hairline', () => {
    expect(stripGroups(['session', 'notes'])).toEqual([['session'], ['notes']])
    expect(stripGroups(['changes', 'files'])).toEqual([['changes', 'files']])
    expect(stripGroups([])).toEqual([])
    // A folded row (the strip's `…`) keeps the groups of what is left.
    expect(stripGroups(['session', 'changes', 'graph'])).toEqual([['session'], ['changes'], ['graph']])
  })
})
