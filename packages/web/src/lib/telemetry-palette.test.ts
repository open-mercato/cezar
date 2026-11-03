import { describe, expect, it, vi } from 'vitest'

import { taskCommandLabel, TASK_COMMAND_LABELS } from '@open-mercato/cezar-api-client'
import { BINDABLE_COMMANDS } from './keybindings'
import { paletteMode } from '@/components/task-palette/task-palette'
import { createCountBatch, searchModes } from './telemetry'

describe('palette telemetry (spec 2026-10-17-task-palette)', () => {
  it('names every bindable command, and folds the open-ended ids into closed labels', () => {
    for (const { id } of BINDABLE_COMMANDS) expect(taskCommandLabel(id)).toBeDefined()
    expect(taskCommandLabel('tab:3')).toBe('tab')
    expect(taskCommandLabel('layout:My secret plan')).toBe('layout')
    expect(taskCommandLabel('layout:new')).toBe('layout:new')
    expect(taskCommandLabel('open:vscode')).toBe('open')
    expect(taskCommandLabel('open:terminal-resume')).toBe('open:terminal-resume')
    expect(taskCommandLabel('something-new')).toBeUndefined()
    // Every label fits the worker's label charset and length.
    for (const label of TASK_COMMAND_LABELS) expect(label).toMatch(/^[\w .:@/+-]{1,64}$/)
  })

  it('reads a search for its shape only, in the mode the palette really used', () => {
    expect(searchModes('fix login', 'tasks')).toEqual(['tasks'])
    expect(searchModes('src/cart', 'files')).toEqual(['files'])
    // A file search's `#1482` is a path fragment, not a reference.
    expect(searchModes('1482', 'files')).toEqual(['files'])
    expect(searchModes('#1482')).toEqual(['pr_number'])
    // The bare `@` ⌘P fills in itself is not a search.
    expect(searchModes('', 'tasks')).toEqual([])
    expect(searchModes('pin', 'commands')).toEqual(['commands'])
    expect(searchModes('1482')).toEqual(['pr_number'])
    expect(searchModes('#1482', 'tasks')).toEqual(['tasks', 'pr_number'])
    expect(searchModes('pr 1482')).toEqual(['pr_number'])
    expect(searchModes('auto review')).toEqual(['automation'])
    expect(searchModes('fix the 1482 bug')).toEqual([])
  })

  it('counts `>` with no task open as the task search the palette really runs', () => {
    // `paletteMode` with no subject searches tasks for every prefix — the label follows it.
    const { mode, query } = paletteMode('>pin', false)
    expect(searchModes(query, mode === 'all' ? undefined : mode)).toEqual(['tasks'])
  })

  it('batches counts per event and label, and sends them as one value each', () => {
    vi.useFakeTimers()
    try {
      const sent: [string, string, number][] = []
      const batch = createCountBatch((event, label, value) => sent.push([event, label, value]), 60_000)
      for (let i = 0; i < 5; i += 1) batch.add('task_shortcut_used', 'tab')
      batch.add('task_command_run', 'pin')
      expect(sent).toEqual([])
      vi.advanceTimersByTime(60_000)
      expect(sent).toEqual([
        ['task_shortcut_used', 'tab', 5],
        ['task_command_run', 'pin', 1],
      ])
      // A batch over the relay's cap is split, not dropped; an explicit flush sends at once.
      for (let i = 0; i < 1500; i += 1) batch.add('task_shortcut_used', 'tab')
      batch.flush()
      expect(sent.slice(2)).toEqual([
        ['task_shortcut_used', 'tab', 1000],
        ['task_shortcut_used', 'tab', 500],
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
