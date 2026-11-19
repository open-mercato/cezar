import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ManagerMessage, PlanUsageConsumer, PlanUsageConsumerWindow } from '@open-mercato/cezar-api-client'
import {
  managerStartedTasks,
  managerUsageToday,
  ManagerUsageChip,
  replyUsageById,
  ReplyUsageNote,
} from './manager-plan-usage'

afterEach(cleanup)

const NOW = new Date('2026-11-19T14:21:00')
const account = { key: 'claude:default', provider: 'claude' as const, accountId: 'default', label: 'Claude · default' }

const consumer = (over: Partial<PlanUsageConsumer> & Pick<PlanUsageConsumer, 'id' | 'kind' | 'estimatePp'>): PlanUsageConsumer => ({
  title: over.id,
  aloneInferredPp: 0,
  sharedEstimatePp: 0,
  retryWasteEstimatePp: 0,
  ranTogetherWith: { tasks: 0, managers: 0, internal: 0 },
  evidence: 'account-level',
  ...over,
})

const entry = (c: PlanUsageConsumer, over: Partial<PlanUsageConsumerWindow> = {}): PlanUsageConsumerWindow => ({
  windowId: 'w-today',
  account,
  kind: 'five-hour',
  startsAt: new Date('2026-11-19T10:00:00').toISOString(),
  resetsAt: new Date('2026-11-19T15:00:00').toISOString(),
  current: true,
  consumer: c,
  ...over,
})

const manager = consumer({
  id: 'mgr:m1',
  kind: 'manager',
  estimatePp: 5,
  parts: { chat: 4, watch: 0.6, job: 0.4 },
  turns: { chat: 3, watch: 6, job: 1 },
  quietWatchTurns: 6,
  messages: [{ messageId: 'a1', part: 'chat', estimatePp: 1 }, { messageId: 'a2', part: 'watch', estimatePp: 0.1 }],
})

const assistant = (id: string, commands: Array<{ summary: string; output?: string }>): ManagerMessage => ({
  id, seq: 1, at: NOW.toISOString(), kind: 'assistant', text: 'ok', turn: 'chat', streaming: false,
  commands: commands.map((c, i) => ({ id: `${id}-${i}`, tool: 'Bash', ...c })),
})

describe('managerStartedTasks', () => {
  it('reads only task create commands, once each', () => {
    const tasks = managerStartedTasks([
      assistant('a1', [{ summary: 'cez-manager task create "fix"', output: '[[task:p1/r1]]' }]),
      assistant('a2', [{ summary: 'cez-manager task show', output: '[[task:p1/r2]]' }, { summary: 'cez-manager task create "x"', output: '[[task:p1/r1]]' }]),
    ])
    expect(tasks).toEqual([{ projectId: 'p1', runId: 'r1' }])
  })
})

describe('managerUsageToday', () => {
  it('is null when the manager has no entry today — unknown, never 0', () => {
    const old = entry(manager, { current: false, startsAt: '2026-11-17T10:00:00Z', resetsAt: '2026-11-17T15:00:00Z' })
    expect(managerUsageToday([old], 'm1', [], NOW)).toBeNull()
    expect(managerUsageToday(undefined, 'm1', [], NOW)).toBeNull()
  })

  it('sums today\'s 5-hour windows and the tasks it started, ignoring weekly entries and other tasks', () => {
    const earlier = entry({ ...manager, estimatePp: 2 }, {
      windowId: 'w-early', current: false,
      startsAt: new Date('2026-11-19T04:00:00').toISOString(), resetsAt: new Date('2026-11-19T09:00:00').toISOString(),
    })
    const weekly = entry(manager, { kind: 'weekly', windowId: 'wk' })
    const task = entry(consumer({ id: 'run:p1/r1', kind: 'task', estimatePp: 35 }))
    const other = entry(consumer({ id: 'run:p1/r9', kind: 'task', estimatePp: 50 }))
    const usage = managerUsageToday([entry(manager), earlier, weekly, task, other], 'm1', [{ projectId: 'p1', runId: 'r1' }], NOW)!
    expect(usage.totalPp).toBe(7)
    expect(usage.windows.map((w) => w.windowId)).toEqual(['w-early', 'w-today'])
    expect(usage.tasks).toEqual({ count: 1, pp: 35 })
  })

  it('skips the tasks row when no started task has an estimate', () => {
    expect(managerUsageToday([entry(manager)], 'm1', [{ projectId: 'p1', runId: 'r1' }], NOW)!.tasks).toBeNull()
  })
})

describe('ManagerUsageChip', () => {
  it('renders the chip and the breakdown with every share marked ≈ and the window named', () => {
    const usage = managerUsageToday([entry(manager), entry(consumer({ id: 'run:p1/r1', kind: 'task', estimatePp: 35 }))], 'm1', [{ projectId: 'p1', runId: 'r1' }], NOW)
    render(<ManagerUsageChip name="Release manager" usage={usage} />)
    const chip = document.querySelector('[data-slot="manager-usage-chip"]')!
    expect(chip.textContent).toBe('Today ≈ 5% of 5h')
    fireEvent.click(chip)
    expect(screen.getByText('Release manager — today')).toBeTruthy()
    expect(screen.getByText(/^Claude · default · 5-hour limit .+–.+$/)).toBeTruthy()
    expect(screen.getByText('≈ 5% of the 5-hour limit')).toBeTruthy()
    const row = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)!.textContent
    expect(row('manager-usage-chat')).toBe('Chat (3 replies)≈ 4%')
    expect(row('manager-usage-watch')).toBe('Watch checks (6, nothing new found)≈ 0.6%')
    expect(row('manager-usage-job')).toBe('Jobs (1)≈ 0.4%')
    expect(row('manager-usage-tasks-row')).toBe('Tasks it started (1), counted on those tasks≈ 35%')
    expect(screen.getByText(/^Never counted twice/)).toBeTruthy()
  })

  it('renders nothing without usage', () => {
    const { container } = render(<ManagerUsageChip name="M" usage={null} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('reply footnote', () => {
  it('maps each assistant message to its estimate and window, and only those with an entry', () => {
    const replies = replyUsageById([entry(manager), entry(manager, { kind: 'weekly' })], 'm1')
    expect([...replies.keys()]).toEqual(['a1', 'a2'])
    expect(replies.get('a1')!.pp).toBe(1)
    expect(replies.get('a1')!.where).toMatch(/^Claude · default · 5-hour limit/)
    expect(replies.has('missing')).toBe(false)
    render(<ReplyUsageNote usage={replies.get('a2')!} />)
    expect(document.querySelector('[data-slot="manager-reply-usage"]')!.textContent).toMatch(/^This reply ≈ 0.1% of 5h \(Claude · default/)
  })
})
