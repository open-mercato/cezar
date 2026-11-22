import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { clockTime } from '@/lib/plan-usage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagerMessage, PlanUsageConsumer, PlanUsageConsumerWindow, PlanUsageTurnStats, PlanUsageWindow } from '@open-mercato/cezar-api-client'
import {
  limitLevel,
  managerAccountKey,
  managerPlanUsage,
  managerStartedTasks,
  ManagerLimitStrip,
  ManagerUsageChip,
  ReplyUsageNote,
  replyUsageById,
  replyUsageDetail,
  couldBeTask,
  tokenCount,
  turnReasons,
  turnShape,
  turnTokens,
  type AccountNow,
} from './manager-plan-usage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const NOW = new Date('2026-11-19T14:21:00')
const account = { key: 'claude:default', provider: 'claude' as const, accountId: 'default', label: 'Claude · default' }
const KEY = account.key

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

const turn = (messageId: string, part: 'chat' | 'watch' | 'job', estimatePp: number, aloneInferredPp: number) =>
  ({ messageId, part, at: new Date('2026-11-19T12:30:00').toISOString(), estimatePp, aloneInferredPp, sharedEstimatePp: estimatePp - aloneInferredPp })

const manager = consumer({
  id: 'mgr:m1',
  kind: 'manager',
  estimatePp: 5,
  aloneInferredPp: 2,
  sharedEstimatePp: 3,
  ranTogetherWith: { tasks: 2, managers: 0, internal: 0 },
  parts: { chat: 4, watch: 0.6, job: 0.4 },
  turns: { chat: 3, watch: 6, job: 1 },
  quietWatchTurns: 6,
  messages: [turn('a2', 'watch', 0.1, 0.1), turn('a1', 'chat', 3, 1), turn('a3', 'chat', 0.5, 0), turn('a4', 'job', 0.4, 0.4)],
})
const STARTED = [{ projectId: 'p1', runId: 'r1' }, { projectId: 'p1', runId: 'r2' }]
const task = (runId: string, pp: number, over: Partial<PlanUsageConsumerWindow> = {}) =>
  entry(consumer({ id: `run:p1/${runId}`, kind: 'task', runId, title: `Task ${runId}`, estimatePp: pp }), over)

const assistant = (id: string, commands: Array<{ summary: string; output?: string }>): ManagerMessage => ({
  id, seq: 1, at: NOW.toISOString(), kind: 'assistant', text: 'ok', turn: 'chat', streaming: false,
  commands: commands.map((c, i) => ({ id: `${id}-${i}`, tool: 'Bash', ...c })),
})

const window = (kind: 'five-hour' | 'weekly', last: number, over: Partial<PlanUsageWindow> = {}): PlanUsageWindow => ({
  id: `claude:default:${kind}:x`, account, kind,
  startsAt: new Date('2026-11-19T10:00:00').toISOString(),
  resetsAt: new Date(kind === 'weekly' ? '2026-11-25T09:00:00' : '2026-11-19T15:00:00').toISOString(),
  current: true, usedPercent: { first: 0, last }, readings: [], consumers: [],
  beforeTrackingPp: 0, outsideCezarPp: 0, unsplitPp: 0, untrackedPp: 0, trackingGaps: [], correctionPp: 0, leftPp: 100 - last,
  ...over,
})
const accountNow = (five: number | null, week: number | null = 29): AccountNow => {
  const fiveHour = five === null ? undefined : window('five-hour', five)
  return { key: KEY, fiveHour, week: week === null ? undefined : window('weekly', week), level: limitLevel(fiveHour) }
}

describe('managerStartedTasks', () => {
  it('reads only task create commands, once each', () => {
    const tasks = managerStartedTasks([
      assistant('a1', [{ summary: 'cez-manager task create "fix"', output: '[[task:p1/r1]]' }]),
      assistant('a2', [{ summary: 'cez-manager task show', output: '[[task:p1/r2]]' }, { summary: 'cez-manager task create "x"', output: '[[task:p1/r1]]' }]),
    ])
    expect(tasks).toEqual([{ projectId: 'p1', runId: 'r1' }])
  })
})

describe('managerAccountKey', () => {
  it('prefers the pinned account, then the one it last ran on, then the runner default', () => {
    const codex = entry(manager, { account: { ...account, key: 'codex:work', provider: 'codex', accountId: 'work' } })
    expect(managerAccountKey([entry(manager)], 'm1', 'claude', 'work')).toBe('claude:work')
    expect(managerAccountKey([entry(manager, { account: { ...account, key: 'claude:alt', accountId: 'alt' } }), codex], 'm1', 'claude', undefined)).toBe('claude:alt')
    expect(managerAccountKey([], 'm1', 'codex', undefined)).toBe('codex:default')
  })
})

describe('managerPlanUsage', () => {
  it('is null when neither the manager nor its tasks have an entry today — unknown, never 0', () => {
    const old = entry(manager, { current: false, startsAt: '2026-11-17T10:00:00Z', resetsAt: '2026-11-17T15:00:00Z' })
    expect(managerPlanUsage([old], 'm1', [], KEY, NOW)).toBeNull()
    expect(managerPlanUsage(undefined, 'm1', [], KEY, NOW)).toBeNull()
  })

  it('adds the tasks it started to the manager in the latest window, and keeps earlier windows and other work apart', () => {
    const earlier = { windowId: 'w-early', current: false, startsAt: new Date('2026-11-19T04:00:00').toISOString(), resetsAt: new Date('2026-11-19T09:00:00').toISOString() }
    const u = managerPlanUsage([
      entry(manager), task('r1', 12), task('r2', 6),
      entry({ ...manager, estimatePp: 2 }, earlier), task('r1', 1, earlier),
      entry(manager, { kind: 'weekly', windowId: 'wk' }), task('r1', 2, { kind: 'weekly', windowId: 'wk' }),
      task('r9', 50),
      task('r2', 9, { account: { ...account, key: 'claude:alt', accountId: 'alt' }, windowId: 'alt' }),
    ], 'm1', STARTED, KEY, NOW)!
    expect(u.windowId).toBe('w-today')
    expect(u.totalPp).toBe(23)
    expect(u.tasks.map((t) => [t.title, t.pp])).toEqual([['Task r1', 12], ['Task r2', 6]])
    expect(u.earlierTodayPp).toBe(3)
    expect(u.weekPp).toBe(7)
    expect(u.otherAccountTasks).toBe(1)
    expect(u.topTurns.map((t) => t.messageId)).toEqual(['a1', 'a3', 'a4'])
  })

  it('counts a started task the ledger filed under the `default` project alias, even before the manager spent anything', () => {
    const t = entry(consumer({ id: 'run:default/r1', kind: 'task', runId: 'r1', title: 'Fix', estimatePp: 35 }))
    const u = managerPlanUsage([t], 'm1', STARTED, KEY, NOW)!
    expect(u.manager).toBeNull()
    expect(u.totalPp).toBe(35)
  })
})

describe('limitLevel', () => {
  it('is amber from 80 %, red from 95 % or once the provider blocks', () => {
    expect(limitLevel(undefined)).toBeNull()
    expect(limitLevel(window('five-hour', 63))).toBe('ok')
    expect(limitLevel(window('five-hour', 80))).toBe('warning')
    expect(limitLevel(window('five-hour', 95))).toBe('critical')
    expect(limitLevel(window('five-hour', 70, { limitReachedAt: NOW.toISOString() }))).toBe('critical')
  })
})

const renderIn = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)
const row = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)
const rowText = (slot: string) => {
  const dd = row(slot)!
  return `${dd.previousElementSibling!.textContent} ${dd.textContent}`
}

describe('ManagerUsageChip', () => {
  const usage = () => managerPlanUsage([entry(manager), task('r1', 12), task('r2', 6), entry(manager, { kind: 'weekly', windowId: 'wk' })], 'm1', STARTED, KEY, NOW)

  it('shows the account meter and manager + tasks, and opens the shared breakdown', () => {
    renderIn(<ManagerUsageChip usage={usage()} account={accountNow(63)} provider="claude" now={NOW.getTime()} />)
    const chip = row('manager-usage-chip')!
    expect(chip.textContent).toBe('63% of 5h · manager + tasks ≈ 23%')
    expect(chip.getAttribute('data-level')).toBe('ok')
    expect(chip.getAttribute('aria-label')).toMatch(/^Plan limit: 63% of the 5-hour limit used, resets .+; this manager and its tasks ≈ 23%$/)
    fireEvent.click(chip)
    const details = within(screen.getByRole('dialog'))
    expect(details.getByText(/^Account now · Claude · default$/)).toBeTruthy()
    expect(row('manager-usage-account-five')!.textContent).toMatch(/63% used.*resets .+ · in 39 min/)
    expect(row('manager-usage-account-week')!.textContent).toMatch(/^Week29% used/)
    expect(details.getByText('Plan limit used by this manager and its tasks')).toBeTruthy()
    expect(row('plan-usage-window')!.textContent).toMatch(/^Claude · default · 5-hour limit .+–.+$/)
    expect(row('plan-usage-total')!.textContent).toBe('≈ 23% of the 5-hour limit · ≈ 5% of the week')
    expect(rowText('manager-usage-self')).toBe('The manager itself ≈ 5%')
    expect(rowText('manager-usage-chat')).toBe('Chat (3 replies) ≈ 4%')
    expect(rowText('manager-usage-watch')).toBe('Watch checks (6, nothing new found) ≈ 0.6%')
    expect(rowText('manager-usage-job')).toBe('Jobs (1) ≈ 0.4%')
    expect(rowText('manager-usage-alone')).toBe('While it was the only cezar work ≈ 2%')
    expect(rowText('manager-usage-shared')).toBe('Its share while 2 other tasks ran ≈ 3%')
    expect(rowText('manager-usage-tasks')).toBe('Tasks it started (2) ≈ 18%')
    expect(rowText('manager-usage-task-0')).toBe('Task r1 ≈ 12%')
    expect(rowText('manager-usage-turn-0')).toMatch(/^Chat reply · .+ · partly shared ≈ 3%$/)
    expect(rowText('manager-usage-turn-2')).toMatch(/^Job · .+ · ran alone ≈ 0.4%$/)
    expect(details.getByText(/^Approximate: Claude reports usage per account, so busy periods are split by each task's and manager's cost/)).toBeTruthy()
    const link = details.getByRole('link', { name: 'See all tasks and managers on this account' })
    expect(link.getAttribute('href')).toBe('/dashboard?view=costs&planAccount=claude%3Adefault&planWindow=w-today')
  })

  it('is a real button: focusable, and Escape closes the breakdown', () => {
    renderIn(<ManagerUsageChip usage={usage()} account={accountNow(63)} provider="claude" now={NOW.getTime()} />)
    const chip = row('manager-usage-chip') as HTMLButtonElement
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    chip.focus()
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a bottom sheet with the same breakdown on a phone', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 767px)', addEventListener() {}, removeEventListener() {} }))
    renderIn(<ManagerUsageChip usage={usage()} account={accountNow(63)} provider="claude" now={NOW.getTime()} />)
    fireEvent.click(row('manager-usage-chip')!)
    const sheet = screen.getByRole('dialog')
    expect(sheet.getAttribute('data-slot')).toBe('manager-usage-popover')
    expect(sheet.className).toContain('bottom-0')
    expect(within(sheet).getByRole('heading', { name: 'Plan limit used by this manager and its tasks' })).toBeTruthy()
    expect(rowText('manager-usage-tasks')).toBe('Tasks it started (2) ≈ 18%')
  })

  it('still shows the account when the manager spent nothing today, and nothing at all with neither', () => {
    const { unmount } = renderIn(<ManagerUsageChip usage={null} account={accountNow(40)} provider="claude" now={NOW.getTime()} />)
    expect(row('manager-usage-chip')!.textContent).toBe('40% of 5h')
    fireEvent.click(row('manager-usage-chip')!)
    expect(row('manager-usage-none')!.textContent).toBe('Nothing measured for this manager today.')
    unmount()
    const { container } = renderIn(<ManagerUsageChip usage={null} account={accountNow(null)} provider="claude" now={NOW.getTime()} />)
    expect(container.innerHTML).toBe('')
  })

  it('falls back to manager + tasks when the account has no reading', () => {
    renderIn(<ManagerUsageChip usage={usage()} account={accountNow(null)} provider="claude" now={NOW.getTime()} />)
    expect(row('manager-usage-chip')!.textContent).toBe('Manager + tasks ≈ 23% of 5h')
  })
})

describe('ManagerLimitStrip', () => {
  it('stays away below 80 %', () => {
    const { container } = renderIn(<ManagerLimitStrip usage={null} account={accountNow(79)} provider="claude" now={NOW.getTime()} />)
    expect(container.innerHTML).toBe('')
  })

  it('warns near the limit and opens the same breakdown', () => {
    renderIn(<ManagerLimitStrip usage={null} account={accountNow(86, 41)} provider="claude" now={NOW.getTime()} />)
    const strip = row('manager-limit-strip')!
    expect(strip.getAttribute('data-level')).toBe('warning')
    expect(strip.textContent).toMatch(/^5-hour limit 86% used · resets .+ \(in 39 min\) · week 41%$/)
    fireEvent.click(strip)
    expect(within(screen.getByRole('dialog')).getByText('Plan limit used by this manager and its tasks')).toBeTruthy()
  })

  it('says the limit is reached once the provider blocks', () => {
    const fiveHour = window('five-hour', 100, { limitReachedAt: NOW.toISOString() })
    renderIn(<ManagerLimitStrip usage={null} account={{ key: KEY, fiveHour, week: undefined, level: limitLevel(fiveHour) }} provider="claude" now={NOW.getTime()} />)
    expect(row('manager-limit-strip')!.getAttribute('data-level')).toBe('critical')
    expect(row('manager-limit-strip')!.textContent).toMatch(/^5-hour limit reached · resets/)
  })
})

describe('turn shape (spec 2026-11-21-manager-short-sessions-and-memory § 2.3)', () => {
  const stats = (over: Partial<PlanUsageTurnStats> = {}): PlanUsageTurnStats => ({
    requests: 2, contextFirst: 30_000, contextPeak: 35_000, toolResultChars: 500,
    tools: { route: 1, look: 0, own: 0, write: 0 }, fresh: false, sessionTurn: 3, idleMs: 60_000, ...over,
  })

  it('names why a turn was expensive', () => {
    expect(turnReasons(stats())).toEqual([])
    expect(turnReasons(stats({ idleMs: 9.5 * 3_600_000, contextPeak: 942_220, requests: 5 }))).toEqual(['cold start after 10 h idle', 'large context'])
    expect(turnReasons(stats({ fresh: true, requests: 7, toolResultChars: 29_000 }))).toEqual(['many requests', 'big tool output', 'new session'])
    // The recorded flag wins over the idle-gap guess: a short gap can still miss the cache, a long one hit it.
    expect(turnReasons(stats({ cold: true, idleMs: 120_000 }))).toEqual(['cold start'])
    expect(turnReasons(stats({ cold: false, idleMs: 2 * 3_600_000 }))).toEqual([])
  })

  it('sums routing against its own work and counts turns a task could have done', () => {
    expect(turnShape([{ turn: stats() }, { turn: stats({ requests: 8, contextPeak: 45_000, tools: { route: 0, look: 2, own: 5, write: 1 } }) }, {}])).toEqual({
      turns: 2, avgContext: 40_000, avgRequests: 5, tools: { route: 1, look: 2, own: 5, write: 1 }, couldBeTasks: 1, tokens: null,
    })
    expect(turnShape([{}])).toBeNull()
    // Files a manager writes carry text to a task: routing, never a reason to call it a task.
    expect(couldBeTask(stats({ tools: { route: 1, look: 0, own: 0, write: 9 } }))).toBe(false)
  })

  it('reads a turn’s token split, and sums it only over the turns that reported one', () => {
    const tokens = { cacheReadTokens: 3_743_343, cacheWriteTokens: 942_218, outputTokens: 3494 }
    expect(turnTokens(stats())).toBeNull()
    expect(turnTokens(stats(tokens))).toEqual({ cacheRead: 3_743_343, cacheWrite: 942_218, output: 3494 })
    expect(turnShape([{ turn: stats(tokens) }, { turn: stats({ cacheReadTokens: 56_657, cacheWriteTokens: 1_782, outputTokens: 506 }) }, { turn: stats() }])?.tokens)
      .toEqual({ cacheRead: 3_800_000, cacheWrite: 944_000, output: 4000 })
    expect([950, 13_400, 942_218, 3_743_343, 12_500_000].map(tokenCount)).toEqual(['950', '13k', '942k', '3.7M', '13M'])
    // Rounded first, so a unit never shows its own upper bound.
    expect([999.4, 999.6, 999_499, 999_500, 999_999, 9_949_999, 9_950_000, 9_999_999].map(tokenCount))
      .toEqual(['999', '1k', '999k', '1.0M', '1.0M', '9.9M', '10M', '10M'])
  })

  it('shows the reason under a largest turn and the window’s turn shape', () => {
    const withStats = consumer({ ...manager, messages: [{ ...turn('a1', 'chat', 5, 1), turn: stats({ idleMs: 9.5 * 3_600_000, contextPeak: 942_220, requests: 5, cacheReadTokens: 3_743_343, cacheWriteTokens: 942_218, outputTokens: 3494 }) }] })
    const u = managerPlanUsage([entry(withStats)], 'm1', [], KEY, NOW)!
    renderIn(<ManagerUsageChip usage={u} account={accountNow(63)} provider="claude" now={NOW.getTime()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(row('manager-usage-turn-detail')!.textContent).toBe('5 requests · 942k context · cold start after 10 h idle, large context')
    expect(row('manager-usage-shape')!.textContent).toContain('942k context · 5.0 requests per turn (1 turn)')
    expect(row('manager-usage-shape')!.textContent).toContain('Tool calls: 1 routing work to tasks, 0 looking up state, 0 its own work')
    expect(row('manager-usage-turn-tokens')!.textContent).toBe('3.7M cache read · 942k cache written · 3k output')
    expect(row('manager-usage-shape-tokens')!.textContent).toBe('Tokens: 3.7M cache read · 942k cache written · 3k output')
  })
})

describe('the reply footnote (restored 2026-11-22)', () => {
  const stats = (over: Record<string, unknown> = {}) => ({
    requests: 2, contextFirst: 30_000, contextPeak: 35_000, toolResultChars: 0,
    tools: { route: 1, look: 0, own: 0, write: 0 }, fresh: false, sessionTurn: 7, ...over,
  })

  it('finds every recent reply by its message id, the first reply after a session restart included', () => {
    // a1 ran late in the old session; a2 was the first turn of the new one, after a restart.
    const mine = consumer({ ...manager, messages: [
      { ...turn('a1', 'chat', 0.9, 0.9), turn: stats() },
      { ...turn('a2', 'chat', 0.3, 0), turn: stats({ fresh: true, sessionTurn: 1, contextPeak: 32_000 }) },
    ] })
    const earlier = consumer({ ...manager, messages: [turn('a1', 'chat', 0.2, 0)] })
    const replies = replyUsageById([entry(mine), entry(earlier, { windowId: 'w-earlier' }), entry(mine, { kind: 'weekly', windowId: 'wk' })], 'm1')
    expect(replies.get('a2')).toMatchObject({ pp: 0.3, alonePp: 0, windows: [expect.stringMatching(/^Claude · default · 5-hour limit /)], turn: { fresh: true } })
    // A reply split across two 5-hour windows adds up; weekly windows never count.
    expect(replies.get('a1')?.pp).toBeCloseTo(1.1)
    expect(replies.has('nope')).toBe(false)
    expect(replyUsageById([entry(consumer({ ...manager, id: 'mgr:other' }))], 'm1').size).toBe(0)
  })

  it('gives a reply whose share rounded to 0 no line at all, never "—" or a false "ran alone"', () => {
    const mine = consumer({ ...manager, messages: [turn('zero', 'chat', 0, 0), turn('some', 'chat', 0.01, 0)] })
    const other = consumer({ ...manager, messages: [turn('split', 'chat', 0, 0)] })
    const third = consumer({ ...manager, messages: [turn('split', 'chat', 0.4, 0.4)] })
    const replies = replyUsageById([entry(mine), entry(other, { windowId: 'w2' }), entry(third, { windowId: 'w3' })], 'm1')
    expect(replies.has('zero')).toBe(false)
    expect(replies.get('some')?.pp).toBe(0.01)
    // A window where it rounded to 0 adds no window name either.
    expect(replies.get('split')).toMatchObject({ pp: 0.4, alonePp: 0.4, windows: [expect.any(String)] })
  })

  it('lists a split reply’s windows oldest first, whatever the report’s order', () => {
    const late = consumer({ ...manager, messages: [turn('a1', 'chat', 0.5, 0)] })
    const early = consumer({ ...manager, messages: [turn('a1', 'chat', 0.2, 0)] })
    const replies = replyUsageById([
      entry(late, { windowId: 'late', startsAt: new Date('2026-11-19T15:00:00').toISOString(), resetsAt: new Date('2026-11-19T20:00:00').toISOString() }),
      entry(early, { windowId: 'early', startsAt: new Date('2026-11-19T10:00:00').toISOString(), resetsAt: new Date('2026-11-19T15:00:00').toISOString() }),
    ], 'm1')
    expect(replies.get('a1')!.windows.map((w) => w.replace(/^.*5-hour limit /, ''))).toEqual([
      `${clockTime(new Date('2026-11-19T10:00:00').toISOString())}–${clockTime(new Date('2026-11-19T15:00:00').toISOString())}`,
      `${clockTime(new Date('2026-11-19T15:00:00').toISOString())}–${clockTime(new Date('2026-11-19T20:00:00').toISOString())}`,
    ])
  })

  it('names every window a split reply came from', () => {
    const mine = consumer({ ...manager, messages: [turn('a1', 'chat', 0.9, 0.9)] })
    const earlier = consumer({ ...manager, messages: [turn('a1', 'chat', 0.2, 0)] })
    const replies = replyUsageById([entry(mine), entry(earlier, { windowId: 'w-earlier', startsAt: new Date('2026-11-19T05:00:00').toISOString(), resetsAt: new Date('2026-11-19T10:00:00').toISOString() })], 'm1')
    expect(replies.get('a1')?.windows).toHaveLength(2)
    expect(replyUsageDetail(replies.get('a1')!)).toMatch(/^Claude · default · 5-hour limit .+ and Claude · default · 5-hour limit .+ · partly shared with other work$/)
  })

  it('reads as before #2363, and its breakdown opens on click, with the window, the split and the turn', () => {
    const usage = { pp: 0.3, alonePp: 0, windows: ['Claude · default · 5-hour limit 10:00–15:00'], turn: stats({ fresh: true, sessionTurn: 1, contextPeak: 32_000 }) }
    expect(replyUsageDetail(usage)).toBe('Claude · default · 5-hour limit 10:00–15:00 · shared with other work · 2 requests · 32k context')
    expect(replyUsageDetail({ pp: 1, alonePp: 1, windows: ['w'] })).toBe('w · ran alone')
    render(<ReplyUsageNote usage={usage} />)
    const note = screen.getByRole('button', { name: 'This reply ≈ 0.3% of 5h: show what it cost' })
    expect(note.textContent).toBe('This reply ≈ 0.3% of 5h')
    fireEvent.click(note)
    const details = within(screen.getByRole('dialog'))
    expect(details.getByText('What this reply cost')).toBeTruthy()
    expect(details.getByText('Claude · default · 5-hour limit 10:00–15:00')).toBeTruthy()
    expect(details.getByText('It shared with other work.')).toBeTruthy()
    expect(rowText('manager-reply-usage-share')).toBe('Share of the 5-hour limit ≈ 0.3%')
    expect(document.querySelector('[data-slot="manager-reply-usage-alone"]')).toBeNull()
    expect(rowText('manager-reply-usage-requests')).toBe('Model requests 2')
    expect(rowText('manager-reply-usage-context')).toBe('Peak context 32k tokens')
  })

  it('shows its detail as the trigger’s tooltip, and the part measured alone', async () => {
    const usage = { pp: 0.9, alonePp: 0.6, windows: ['Claude · default · 5-hour limit 10:00–15:00'], turn: stats() }
    render(<ReplyUsageNote usage={usage} />)
    const note = screen.getByRole('button', { name: /^This reply ≈ 0.9% of 5h/ })
    fireEvent.pointerMove(note)
    fireEvent.focus(note)
    await waitFor(() => expect(document.querySelector('[data-slot="icon-tooltip"]')?.textContent).toContain(replyUsageDetail(usage)))
    expect(replyUsageDetail(usage)).toContain('partly shared with other work')
    fireEvent.click(note)
    expect(rowText('manager-reply-usage-alone')).toBe('While no other cezar work ran ≈ 0.6%')
  })

  it('opens the same breakdown as a bottom sheet on a phone', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 767px)', addEventListener() {}, removeEventListener() {} }))
    render(<ReplyUsageNote usage={{ pp: 0.8, alonePp: 0.8, windows: ['Claude · default · 5-hour limit 10:00–15:00'] }} />)
    fireEvent.click(screen.getByRole('button', { name: /^This reply ≈ 0.8% of 5h/ }))
    const sheet = screen.getByRole('dialog')
    expect(sheet.getAttribute('data-slot')).toBe('manager-reply-usage-details')
    expect(sheet.className).toContain('bottom-0')
    expect(within(sheet).getByRole('heading', { name: 'What this reply cost' })).toBeTruthy()
    expect(within(sheet).getByText('It ran alone.')).toBeTruthy()
  })
})
