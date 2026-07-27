import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'
import { wantsAttention } from '@/lib/attention'
import {
  DEFAULT_NOTIFICATIONS,
  describeRunNotification,
  diffRunTransitions,
  normalizeNotifications,
  notificationSupport,
  shouldNotify,
  type NotificationSupport,
} from '@/lib/notifications'

/**
 * The pure half of R6 Step 1.7: attention→notify transition mapping, the off-by-default
 * preference, and the enabled/hidden/permission gate. The impure sliver (constructing the
 * `Notification`, the cache subscription) is pinned in components/run-notifications.test.tsx.
 */

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    title: 'Normalize the agent-event protocol',
    workflow: 'default',
    task: 'normalize the protocol',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('normalizeNotifications (the ui-state `notifications` key)', () => {
  it('is OFF by default — an absent key, and the exported default, both say so', () => {
    expect(DEFAULT_NOTIFICATIONS).toEqual({ enabled: false })
    expect(normalizeNotifications(undefined)).toEqual({ enabled: false })
    expect(normalizeNotifications({})).toEqual({ enabled: false })
  })

  it('only the literal true enables', () => {
    expect(normalizeNotifications({ enabled: true })).toEqual({ enabled: true })
    // The server schema is a passthrough, so any shape can come back — none of these count.
    for (const raw of [{ enabled: 'true' }, { enabled: 1 }, { enabled: null }, 'yes', 42, []]) {
      expect(normalizeNotifications(raw)).toEqual({ enabled: false })
    }
  })
})

describe('diffRunTransitions (attention → notify mapping)', () => {
  const seen = (entries: Array<[string, RunStatus]>) => new Map<string, RunStatus>(entries)

  it('a run ENTERING waiting/review/failed notifies — the spec set, via wantsAttention', () => {
    for (const status of ['waiting', 'review', 'failed'] as const) {
      const { entering } = diffRunTransitions(seen([['r1', 'running']]), [run({ status })])
      expect(entering.map((r) => r.id)).toEqual(['r1'])
    }
  })

  it('the entering set IS wantsAttention — never a second status list', () => {
    const all: readonly RunStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']
    for (const status of all) {
      const record = run({ status })
      const { entering } = diffRunTransitions(seen([['r1', 'queued']]), [record])
      // status change from 'queued' in every case except 'queued' itself; notify iff attention.
      expect(entering.includes(record)).toBe(status !== 'queued' && wantsAttention(record))
    }
  })

  it('first sight never notifies, whatever the status — boot and reconnect seed silently', () => {
    const { entering, statuses } = diffRunTransitions(new Map(), [
      run({ id: 'a', status: 'waiting' }),
      run({ id: 'b', status: 'failed' }),
    ])
    expect(entering).toEqual([])
    expect(statuses).toEqual(seen([['a', 'waiting'], ['b', 'failed']]))
  })

  it('an unchanged status never notifies — token ticks re-announce the same state', () => {
    const { entering } = diffRunTransitions(seen([['r1', 'waiting']]), [run({ status: 'waiting' })])
    expect(entering).toEqual([])
  })

  it('a transition BETWEEN attention states still notifies (waiting → failed is news)', () => {
    const { entering } = diffRunTransitions(seen([['r1', 'waiting']]), [run({ status: 'failed' })])
    expect(entering.map((r) => r.id)).toEqual(['r1'])
  })

  it('leaving attention notifies nothing (waiting → done)', () => {
    const { entering } = diffRunTransitions(seen([['r1', 'waiting']]), [run({ status: 'done' })])
    expect(entering).toEqual([])
  })

  it('entering monitoring never notifies — it is a running sub-state, not attention (#490)', () => {
    const monitoring = run({ status: 'running', activity: 'monitoring' })
    // From active running (no status change) and from waiting (leaving attention): neither notifies.
    expect(diffRunTransitions(seen([['r1', 'running']]), [monitoring]).entering).toEqual([])
    expect(diffRunTransitions(seen([['r1', 'waiting']]), [monitoring]).entering).toEqual([])
  })

  it('rebuilds the status map each observation, so deleted runs fall out', () => {
    const { statuses } = diffRunTransitions(seen([['gone', 'running'], ['r1', 'running']]), [
      run({ id: 'r1', status: 'running' }),
    ])
    expect(statuses.has('gone')).toBe(false)
  })

  it('an undefined list (cache never fetched) observes nothing', () => {
    const { entering, statuses } = diffRunTransitions(seen([['r1', 'running']]), undefined)
    expect(entering).toEqual([])
    expect(statuses.size).toBe(0)
  })
})

describe('shouldNotify (toggle gating + permission degradation)', () => {
  it('fires only with the toggle on, the tab hidden AND permission granted', () => {
    expect(shouldNotify({ enabled: true, hidden: true, permission: 'granted' })).toBe(true)
  })

  it('the toggle gates: off means silence even when everything else lines up', () => {
    expect(shouldNotify({ enabled: false, hidden: true, permission: 'granted' })).toBe(false)
  })

  it('a visible tab is silent — the pulsing dot already says it', () => {
    expect(shouldNotify({ enabled: true, hidden: false, permission: 'granted' })).toBe(false)
  })

  it('denied/default/unsupported permission all degrade to silence, never a throw', () => {
    for (const permission of ['denied', 'default', 'unsupported'] as NotificationSupport[]) {
      expect(shouldNotify({ enabled: true, hidden: true, permission })).toBe(false)
    }
  })
})

describe('notificationSupport', () => {
  it('answers unsupported when there is no Notification constructor at all', () => {
    vi.stubGlobal('Notification', undefined)
    expect(notificationSupport()).toBe('unsupported')
  })

  it('reads the constructor’s permission without calling anything', () => {
    for (const permission of ['granted', 'denied', 'default'] as const) {
      const N = vi.fn()
      ;(N as unknown as { permission: string }).permission = permission
      vi.stubGlobal('Notification', N)
      expect(notificationSupport()).toBe(permission)
      expect(N).not.toHaveBeenCalled()
    }
  })

  it('coerces an unknown permission value to default', () => {
    const N = vi.fn()
    ;(N as unknown as { permission: string }).permission = 'prompt-with-chooser'
    vi.stubGlobal('Notification', N)
    expect(notificationSupport()).toBe('default')
  })
})

describe('describeRunNotification', () => {
  it('titles with the display title (#389: titleSummary ?? title) and bodies with the attention label', () => {
    expect(describeRunNotification(run({ status: 'waiting' }))).toEqual({
      title: 'Normalize the agent-event protocol',
      body: 'Task needs you',
      tag: 'cezar-run-r1',
    })
    expect(
      describeRunNotification(run({ status: 'review', titleSummary: 'Protocol cleanup' })).title,
    ).toBe('Protocol cleanup')
    expect(describeRunNotification(run({ status: 'failed' })).body).toBe('Task failed')
  })

  it('tags stay stable per run, so a later transition replaces rather than piles up', () => {
    const a = describeRunNotification(run({ status: 'waiting' }))
    const b = describeRunNotification(run({ status: 'failed' }))
    expect(a.tag).toBe(b.tag)
  })
})
