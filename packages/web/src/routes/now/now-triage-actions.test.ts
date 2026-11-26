import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AttentionOverride, RunRecord } from '@open-mercato/cezar-api-client'

import { DISMISS_UNDO_MS, resetDismissals } from '@/api/questions'

import { UNDO_TOAST_MS, createTriageActions, questionCloser, type TriageDeps } from './now-triage-actions'
import { keyedQueue } from './now-triage-model'

/** Needs you's wiring (spec 2026-11-23-needs-you-triage): what each click calls, in which order. */

const NOW = new Date(2026, 10, 25, 12).getTime()
const run = { id: 'r1', title: 'Fix login', status: 'waiting' } as unknown as RunRecord

let failClose: ((error: string) => void) | undefined

function harness(over: Partial<TriageDeps> = {}) {
  const calls: string[] = []
  const toasts: Array<{ message: string; opts?: Parameters<TriageDeps['toast']>[1] }> = []
  const deps: TriageDeps = {
    queryClient: new QueryClient(),
    setOverride: vi.fn(async (input) => { calls.push(`set:${input.key}:${input.mode}${input.until ? `:until=${input.until}` : ''}${input.runId ? `:run=${input.runId}` : ''}`); return [] }),
    clearOverride: vi.fn(async (key) => { calls.push(`clear:${key}`); return [] }),
    applyLocally: vi.fn((override) => { calls.push(`local:${override.key}:${override.mode}`) }),
    scheduleClose: vi.fn((key, _label, onFailed) => { calls.push(`close:${key}`); failClose = onFailed }),
    holdClose: vi.fn((key, held) => { calls.push(`hold:${key}:${held}`) }),
    undoClose: vi.fn((key) => { calls.push(`undo-close:${key}`); return true }),
    finishRun: vi.fn(async (id) => { calls.push(`finish:${id}`) }),
    archiveRun: vi.fn(async (id, archived) => { calls.push(`archive:${id}:${archived}`) }),
    setManagerNotify: vi.fn(async (id, notify) => { calls.push(`notify:${id}:${notify}`) }),
    managerMuted: () => false,
    confirmCancel: vi.fn((r) => { calls.push(`confirm-stop:${r.id}`) }),
    copy: vi.fn(async (text) => { calls.push(`copy:${text}`) }),
    origin: 'http://127.0.0.1:4321',
    toast: vi.fn((message, opts) => { toasts.push({ message, opts }) }),
    refreshAttention: vi.fn(async () => undefined),
    refreshRuns: vi.fn(async () => undefined),
    refreshManagers: vi.fn(async () => undefined),
    inOrder: keyedQueue(),
    now: () => NOW,
    ...over,
  }
  return { actions: createTriageActions(deps), deps, calls, toasts, undo: () => (toasts.at(-1)!.opts!.action as { onClick: () => void }).onClick() }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Needs you triage actions', () => {
  it('✕ on a question schedules its card close and dismisses it with its run; Undo reverses both', async () => {
    const { actions, calls, toasts, undo } = harness()
    actions.dismiss({ key: 'question:r:app:r1:q', label: 'Ship it?', questionKey: 'r:app:r1:q', projectId: 'app', runId: 'r1' })
    await settle()
    expect(calls).toEqual(['close:r:app:r1:q', 'local:question:r:app:r1:q:dismiss', 'set:question:r:app:r1:q:dismiss:run=r1'])
    expect(toasts[0]).toMatchObject({ message: 'Dismissed “Ship it?”', opts: { durationMs: UNDO_TOAST_MS } })
    calls.length = 0
    undo()
    await settle()
    expect(calls).toEqual(['undo-close:r:app:r1:q', 'local:question:r:app:r1:q:clear', 'clear:question:r:app:r1:q'])
  })

  it('a failed card close un-hides the row and says why, from the close itself (review 2, finding 5)', async () => {
    const { actions, calls, toasts } = harness()
    actions.dismiss({ key: 'question:m:a:1', label: 'Ship it?', questionKey: 'm:a:1' })
    await settle()
    calls.length = 0
    failClose!('disk full')
    await settle()
    expect(calls).toEqual(['local:question:m:a:1:clear', 'clear:question:m:a:1'])
    expect(toasts.at(-1)).toMatchObject({ message: 'Could not close “Ship it?”: disk full', opts: { tone: 'danger' } })
  })

  it('holding the toast holds the card close (review finding 9)', () => {
    const { actions, calls, toasts } = harness()
    actions.dismiss({ key: 'q', label: 'Q', questionKey: 'm:a:1' })
    calls.length = 0
    toasts[0]!.opts!.onHold!(true)
    toasts[0]!.opts!.onHold!(false)
    expect(calls).toEqual(['hold:m:a:1:true', 'hold:m:a:1:false'])
    // A plain dismissal has no close to hold.
    harness().actions.dismiss({ key: 't', label: 'T' })
  })

  it('says so when Undo came after the close was sent', async () => {
    const { actions, toasts, undo } = harness({ undoClose: () => false })
    actions.dismiss({ key: 'q', label: 'Q', questionKey: 'm:a:1' })
    undo()
    await settle()
    expect(toasts.at(-1)).toMatchObject({ message: 'Too late to undo: the question was already closed', opts: { tone: 'danger' } })
  })

  it('Undo waits for the dismiss still in flight (review finding 5)', async () => {
    let land!: () => void
    const { actions, calls, undo } = harness({
      setOverride: vi.fn(() => new Promise<AttentionOverride[]>((resolve) => { land = () => { calls.push('set landed'); resolve([]) } })),
    })
    actions.dismiss({ key: 't', label: 'T' })
    undo()
    await settle()
    expect(calls).not.toContain('clear:t')
    land()
    await settle()
    await settle()
    expect(calls.slice(-2)).toEqual(['set landed', 'clear:t'])
  })

  it('snoozes until the chosen time and never closes a question', async () => {
    const { actions, calls, toasts, undo } = harness()
    actions.snooze({ key: 'q', label: 'Q', questionKey: 'm:a:1' }, 'tomorrow')
    await settle()
    expect(calls).toEqual(['local:q:dismiss', `set:q:dismiss:until=${new Date(2026, 10, 26, 9).toISOString()}`])
    expect(toasts[0]!.message).toBe('Snoozed “Q” until tomorrow morning')
    calls.length = 0
    undo()
    await settle()
    expect(calls).toEqual(['local:q:clear', 'clear:q'])
  })

  it('archives with an undo, marks done, and stops only through the confirm', async () => {
    const { actions, calls, undo } = harness()
    actions.archive!(run)
    await settle()
    undo()
    await settle()
    actions.finish!(run)
    actions.cancel!(run)
    await settle()
    expect(calls).toEqual(['archive:r1:true', 'archive:r1:false', 'finish:r1', 'confirm-stop:r1'])
  })

  it('mutes a manager with an undo, and copies an absolute link', async () => {
    const { actions, calls, toasts, undo } = harness()
    actions.mute!({ id: 'shop', name: 'Shop manager' }, true)
    await settle()
    expect(toasts[0]!.message).toBe('Muted Shop manager: its items stay listed, uncounted')
    undo()
    actions.copyLink!('/manager/shop#decision-1')
    await settle()
    expect(calls).toEqual(['notify:shop:false', 'notify:shop:true', 'copy:http://127.0.0.1:4321/manager/shop#decision-1'])
  })

  it('a failed write says so and re-reads the list', async () => {
    const { actions, deps, toasts } = harness({ setOverride: vi.fn(async () => { throw new Error('offline') }) })
    actions.keep({ key: 'k', label: 'K' })
    await settle()
    expect(toasts.at(-1)).toMatchObject({ message: 'Could not save that: offline', opts: { tone: 'danger' } })
    expect(deps.refreshAttention).toHaveBeenCalled()
  })
})

describe('questionCloser (review of #2443, round 4)', () => {
  afterEach(() => {
    resetDismissals()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('hands a failed card close back to Now', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'disk full' }, { status: 500 })))
    const onFailed = vi.fn()
    questionCloser(new QueryClient())('m:a:1', 'Ship it?', onFailed)
    await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS)
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith('disk full'))
  })
})

