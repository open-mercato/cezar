import { describe, expect, it, vi } from 'vitest'

import { applyBulkTag, bulkTagMessage, bulkTagState } from './run-tags'

/** Bulk tagging from the selection bar (spec 2026-11-23-task-tags § 7.3). */
describe('bulk tagging', () => {
  const tag = { id: 'tt-batch000001', name: 'batch' }
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `tt-full0000${i}0`, name: `${i}` }))

  it('reads checked, mixed or empty across the selection', () => {
    expect(bulkTagState([{ tags: [tag] }, { tags: [tag] }], tag.id)).toBe('checked')
    expect(bulkTagState([{ tags: [tag] }, {}], tag.id)).toBe('mixed')
    expect(bulkTagState([{}, {}], tag.id)).toBe('empty')
  })

  it('adds only where missing, skips a task at the 10-tag limit, and one failure leaves the others tagged', async () => {
    const send = vi.fn(async ({ runId }: { runId: string }) => {
      if (runId === 'fails') throw new Error('nope')
    })
    const outcome = await applyBulkTag(
      [{ id: 'has', tags: [tag] }, { id: 'one' }, { id: 'two' }, { id: 'full', tags: ten }, { id: 'fails' }],
      tag,
      true,
      send,
    )
    expect(send.mock.calls.map(([edit]) => edit.runId).sort()).toEqual(['fails', 'one', 'two'])
    expect(outcome).toEqual({ changed: 2, skippedCap: 1, failed: 1 })
    expect(bulkTagMessage(tag, true, outcome)).toBe('Tagged 2 tasks with “batch” · 1 skipped (10-tag limit) · 1 failed')
  })

  it('removes from every task that has it', async () => {
    const send = vi.fn(async () => {})
    const outcome = await applyBulkTag([{ id: 'x', tags: [tag] }, { id: 'y' }], tag, false, send)
    expect(send).toHaveBeenCalledWith({ runId: 'x', remove: [tag.id] })
    expect(outcome.changed).toBe(1)
  })
})
