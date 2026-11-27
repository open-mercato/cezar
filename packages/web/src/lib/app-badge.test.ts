import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import {
  countUnreadManagers,
  countUnreadTasks,
  isAppBadgeSupported,
  unreadBadgeCount,
  updateAppBadge,
  useAppBadge,
} from './app-badge'
import type { AttentionCounts } from './managers'

describe('app-badge API support and mapping', () => {
  let originalSetAppBadge: unknown
  let originalClearAppBadge: unknown
  let mockSetAppBadge: ReturnType<typeof vi.fn>
  let mockClearAppBadge: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalSetAppBadge = (navigator as unknown as { setAppBadge?: unknown }).setAppBadge
    originalClearAppBadge = (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge
    mockSetAppBadge = vi.fn().mockResolvedValue(undefined)
    mockClearAppBadge = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      setAppBadge: mockSetAppBadge,
      clearAppBadge: mockClearAppBadge,
    })
  })

  afterEach(() => {
    if (originalSetAppBadge !== undefined) {
      Object.assign(navigator, { setAppBadge: originalSetAppBadge })
    } else {
      delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge
    }
    if (originalClearAppBadge !== undefined) {
      Object.assign(navigator, { clearAppBadge: originalClearAppBadge })
    } else {
      delete (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge
    }
  })

  it('detects when Badging API is supported', () => {
    expect(isAppBadgeSupported()).toBe(true)
  })

  it('detects when Badging API is unsupported', () => {
    delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge
    expect(isAppBadgeSupported()).toBe(false)
  })

  it('sets the badge when count is positive', async () => {
    await updateAppBadge(3)
    expect(mockSetAppBadge).toHaveBeenCalledWith(3)
    expect(mockClearAppBadge).not.toHaveBeenCalled()
  })

  it('clears the badge when count is 0', async () => {
    await updateAppBadge(0)
    expect(mockClearAppBadge).toHaveBeenCalled()
    expect(mockSetAppBadge).not.toHaveBeenCalled()
  })

  it('clears the badge when count is negative', async () => {
    await updateAppBadge(-2)
    expect(mockClearAppBadge).toHaveBeenCalled()
    expect(mockSetAppBadge).not.toHaveBeenCalled()
  })

  it('is a no-op when the Badging API is unsupported', async () => {
    delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge
    delete (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge

    await expect(updateAppBadge(4)).resolves.toBeUndefined()
    await expect(updateAppBadge(0)).resolves.toBeUndefined()
  })

  it('degrades cleanly when navigator.setAppBadge rejects', async () => {
    mockSetAppBadge.mockRejectedValue(new Error('Permission denied'))
    await expect(updateAppBadge(2)).resolves.toBeUndefined()
  })

  it('degrades cleanly when navigator.clearAppBadge rejects', async () => {
    mockClearAppBadge.mockRejectedValue(new Error('Permission denied'))
    await expect(updateAppBadge(0)).resolves.toBeUndefined()
  })
})

describe('useAppBadge hook wiring', () => {
  let mockSetAppBadge: ReturnType<typeof vi.fn>
  let mockClearAppBadge: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSetAppBadge = vi.fn().mockResolvedValue(undefined)
    mockClearAppBadge = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      setAppBadge: mockSetAppBadge,
      clearAppBadge: mockClearAppBadge,
    })
  })

  afterEach(() => {
    delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge
    delete (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge
  })

  it('updates the badge on render and on count changes', () => {
    const { rerender, unmount } = renderHook((count: number) => useAppBadge(count), {
      initialProps: 2,
    })
    expect(mockSetAppBadge).toHaveBeenCalledWith(2)

    rerender(5)
    expect(mockSetAppBadge).toHaveBeenCalledWith(5)

    rerender(0)
    expect(mockClearAppBadge).toHaveBeenCalled()

    unmount()
  })

  it('re-applies the badge when document becomes visible again', () => {
    const { unmount } = renderHook((count: number) => useAppBadge(count), {
      initialProps: 3,
    })
    expect(mockSetAppBadge).toHaveBeenCalledTimes(1)

    // Hidden visibility does not re-apply
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockSetAppBadge).toHaveBeenCalledTimes(1)

    // Visible state re-applies the current badge
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockSetAppBadge).toHaveBeenCalledTimes(2)
    expect(mockSetAppBadge).toHaveBeenLastCalledWith(3)

    unmount()
  })

  it('cleans up the visibilitychange event listener on unmount', () => {
    const { unmount } = renderHook((count: number) => useAppBadge(count), {
      initialProps: 1,
    })
    expect(mockSetAppBadge).toHaveBeenCalledTimes(1)

    unmount()

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockSetAppBadge).toHaveBeenCalledTimes(1)
  })
})

describe('item counting and deduplication', () => {
  const baseRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
    id: 'run-1',
    title: 'Test run',
    task: 'Test task',
    status: 'running',
    workflow: 'workflow',
    createdAt: '2026-11-17T09:00:00.000Z',
    tokensUsed: 0,
    steps: [],
    archived: false,
    ...overrides,
  })

  it('returns 0 when lists are empty or undefined', () => {
    expect(countUnreadTasks(undefined)).toBe(0)
    expect(countUnreadTasks([])).toBe(0)
    expect(countUnreadManagers(undefined)).toBe(0)
    expect(countUnreadManagers([])).toBe(0)
    expect(unreadBadgeCount(undefined, undefined)).toBe(0)
  })

  it('counts tasks waiting on the user', () => {
    const waitingRun = baseRun({ id: 'r1', status: 'waiting' })
    const reviewRun = baseRun({ id: 'r2', status: 'review' })
    const askRun = baseRun({ id: 'r3', status: 'failed', awaitingAnswerSince: '2026-11-17T09:10:00.000Z' })
    const runningRun = baseRun({ id: 'r4', status: 'running' })

    expect(countUnreadTasks([waitingRun, reviewRun, askRun, runningRun])).toBe(3)
  })

  it('counts unread finished tasks and clears when seen', () => {
    const unreadDone = baseRun({
      id: 'r1',
      status: 'done',
      finishedAt: '2026-11-17T09:30:00.000Z',
      seenAt: undefined,
    })
    const readDone = baseRun({
      id: 'r2',
      status: 'done',
      finishedAt: '2026-11-17T09:30:00.000Z',
      seenAt: '2026-11-17T09:35:00.000Z',
    })

    expect(countUnreadTasks([unreadDone, readDone])).toBe(1)

    // Opening the task marks it seen, clearing its unit
    const openedDone = { ...unreadDone, seenAt: '2026-11-17T09:35:00.000Z' }
    expect(countUnreadTasks([openedDone, readDone])).toBe(0)
  })

  it('does not double count a task that matches multiple attention conditions', () => {
    // A failed run with lifecycle needsAttention that is also unread
    const dualAttentionRun = baseRun({
      id: 'r1',
      status: 'failed',
      finishedAt: '2026-11-17T09:30:00.000Z',
      seenAt: undefined,
      worktreeLifecycle: {
        worktreeId: 'wt-1',
        generation: 1,
        activeOperationId: undefined,
        needsAttention: true,
        phase: 'teardown',
      },
    })

    expect(countUnreadTasks([dualAttentionRun])).toBe(1)
  })

  it('does not count archived tasks', () => {
    const archivedWaiting = baseRun({ id: 'r1', status: 'waiting', archived: true })
    const archivedUnread = baseRun({
      id: 'r2',
      status: 'done',
      finishedAt: '2026-11-17T09:30:00.000Z',
      seenAt: undefined,
      archived: true,
    })

    expect(countUnreadTasks([archivedWaiting, archivedUnread])).toBe(0)
  })

  it('counts manager chats with unread replies or approvals and clears when read', () => {
    const managerWithUnread: AttentionCounts = {
      unread: 3,
      pendingActions: 0,
      pendingQuestions: 0,
    }
    const managerWithApprovals: AttentionCounts = {
      unread: 0,
      pendingActions: 2,
      pendingQuestions: 1,
    }
    const managerBoth: AttentionCounts = {
      unread: 10,
      pendingActions: 1,
      pendingQuestions: 0,
    }
    const quietManager: AttentionCounts = {
      unread: 0,
      pendingActions: 0,
      pendingQuestions: 0,
    }

    // Each manager needing attention is exactly 1 unit
    expect(countUnreadManagers([managerWithUnread, managerWithApprovals, quietManager])).toBe(2)
    expect(countUnreadManagers([managerBoth])).toBe(1)

    // Reading the chat clears unread
    const readManager: AttentionCounts = {
      ...managerWithUnread,
      unread: 0,
    }
    expect(countUnreadManagers([readManager, quietManager])).toBe(0)
  })

  it('combines tasks and manager counts into unreadBadgeCount', () => {
    const waitingRun = baseRun({ id: 'r1', status: 'waiting' })
    const unreadDone = baseRun({
      id: 'r2',
      status: 'done',
      finishedAt: '2026-11-17T09:30:00.000Z',
      seenAt: undefined,
    })
    const managerNews: AttentionCounts = { unread: 2, pendingActions: 0, pendingQuestions: 0 }
    const quietManager: AttentionCounts = { unread: 0, pendingActions: 0, pendingQuestions: 0 }

    expect(unreadBadgeCount([waitingRun, unreadDone], [managerNews, quietManager])).toBe(3)
  })
})
