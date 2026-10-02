import { describe, expect, it } from 'vitest'

import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'
import {
  CEZAR_REPO_URL,
  STAR_ASK_KEY,
  STAR_ASK_MAX_ASKS,
  STAR_ASK_PRESENCE_MS,
  STAR_ASK_SNOOZE_MS,
  STAR_TOAST_SEEN_KEY,
  countSuccesses,
  diffSuccessTransition,
  formatStarCount,
  isUserPresent,
  mayAskForStar,
  readStarAsk,
  writeStarAsk,
} from './star-promo'

const run = (id: string, status: RunStatus): RunRecord => ({ id, status }) as RunRecord

describe('formatStarCount', () => {
  it('prints small counts as they are', () => {
    expect(formatStarCount(0)).toBe('0')
    expect(formatStarCount(7)).toBe('7')
    expect(formatStarCount(842)).toBe('842')
    expect(formatStarCount(999)).toBe('999')
  })

  it('switches to thousands at exactly 1000, with one decimal and no trailing .0', () => {
    expect(formatStarCount(1000)).toBe('1k')
    expect(formatStarCount(1200)).toBe('1.2k')
    expect(formatStarCount(12_340)).toBe('12.3k')
    expect(formatStarCount(99_900)).toBe('99.9k')
  })

  it('drops the decimal past 100k, where it is noise in a 264px column', () => {
    expect(formatStarCount(100_000)).toBe('100k')
    expect(formatStarCount(120_400)).toBe('120k')
  })

  it('truncates rather than rounding up — it never prints a count nobody has reached', () => {
    expect(formatStarCount(1299)).toBe('1.2k')
    expect(formatStarCount(999_950)).toBe('999k')
  })

  it('degrades to 0 for values a count can never be', () => {
    expect(formatStarCount(-5)).toBe('0')
    expect(formatStarCount(Number.NaN)).toBe('0')
    expect(formatStarCount(Number.POSITIVE_INFINITY)).toBe('0')
  })
})

describe('the ask record', () => {
  const store = (initial: Record<string, string> = {}) => {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      map,
    }
  }

  it('starts at zero asks on a fresh store and round-trips what it writes', () => {
    const s = store()
    expect(readStarAsk(s)).toEqual({ asks: 0 })
    writeStarAsk({ asks: 2, lastAskedAt: '2026-10-01T10:00:00.000Z', outcome: 'never' }, s)
    expect(JSON.parse(s.map.get(STAR_ASK_KEY)!)).toEqual({
      asks: 2,
      lastAskedAt: '2026-10-01T10:00:00.000Z',
      outcome: 'never',
    })
    expect(readStarAsk(s)).toEqual({ asks: 2, lastAskedAt: '2026-10-01T10:00:00.000Z', outcome: 'never' })
  })

  it('counts a browser that saw the retired toast as one ask spent', () => {
    expect(readStarAsk(store({ [STAR_TOAST_SEEN_KEY]: '2026-10-01T10:00:00.000Z' }))).toEqual({
      asks: 1,
      lastAskedAt: '2026-10-01T10:00:00.000Z',
    })
  })

  it('fails CLOSED: no storage, a throwing read, or a corrupt record never asks', () => {
    // The asymmetry is the point: closed costs one user the ask; open makes it repeat forever.
    expect(readStarAsk(null)).toBeNull()
    expect(
      readStarAsk({
        getItem: () => {
          throw new Error('SecurityError')
        },
      }),
    ).toBeNull()
    expect(readStarAsk(store({ [STAR_ASK_KEY]: '{not json' }))).toBeNull()
    expect(mayAskForStar(readStarAsk(store({ [STAR_ASK_KEY]: '{"asks":"x"}' })), 0)).toBe(false)
  })

  it('never throws when the write fails — a full quota must not take the cockpit down', () => {
    expect(() => writeStarAsk({ asks: 1 }, null)).not.toThrow()
    expect(() =>
      writeStarAsk(
        { asks: 1 },
        {
          setItem: () => {
            throw new Error('QuotaExceededError')
          },
        },
      ),
    ).not.toThrow()
  })
})

describe('mayAskForStar', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('asks a browser never asked before', () => {
    expect(mayAskForStar({ asks: 0 }, now)).toBe(true)
  })

  it('honours "Maybe later" for the whole snooze, then asks again', () => {
    expect(mayAskForStar({ asks: 1, lastAskedAt: ago(STAR_ASK_SNOOZE_MS - 1) }, now)).toBe(false)
    expect(mayAskForStar({ asks: 1, lastAskedAt: ago(STAR_ASK_SNOOZE_MS) }, now)).toBe(true)
  })

  it('stops for good after a star, a "Don\'t ask again", or the last allowed ask', () => {
    expect(mayAskForStar({ asks: 1, outcome: 'starred' }, now)).toBe(false)
    expect(mayAskForStar({ asks: 1, outcome: 'never' }, now)).toBe(false)
    expect(mayAskForStar({ asks: STAR_ASK_MAX_ASKS, lastAskedAt: ago(10 * STAR_ASK_SNOOZE_MS) }, now)).toBe(false)
  })

  it('never asks when the record could not be read', () => {
    expect(mayAskForStar(null, now)).toBe(false)
  })
})

describe('the "really uses cezar" and "watching the screen" gates', () => {
  it('counts only runs that ended well', () => {
    expect(countSuccesses(undefined)).toBe(0)
    expect(
      countSuccesses([run('a', 'done'), run('b', 'review'), run('c', 'failed'), run('d', 'running')]),
    ).toBe(2)
  })

  const present = {
    now: 100_000,
    visible: true,
    focused: true,
    lastInteractionAt: 90_000,
    typing: false,
    dialogOpen: false,
  }
  it('is present when visible, focused, recently touched and idle', () => {
    expect(isUserPresent(present)).toBe(true)
  })
  it('is away in a background tab or an unfocused window', () => {
    expect(isUserPresent({ ...present, visible: false })).toBe(false)
    expect(isUserPresent({ ...present, focused: false })).toBe(false)
  })
  it('is away when nothing moved for longer than the presence window', () => {
    expect(isUserPresent({ ...present, lastInteractionAt: present.now - STAR_ASK_PRESENCE_MS })).toBe(true)
    expect(isUserPresent({ ...present, lastInteractionAt: present.now - STAR_ASK_PRESENCE_MS - 1 })).toBe(false)
    expect(isUserPresent({ ...present, lastInteractionAt: 0, now: STAR_ASK_PRESENCE_MS * 5 })).toBe(false)
  })
  it('never interrupts typing or another dialog', () => {
    expect(isUserPresent({ ...present, typing: true })).toBe(false)
    expect(isUserPresent({ ...present, dialogOpen: true })).toBe(false)
  })
})

describe('diffSuccessTransition', () => {
  it('fires when a run ENTERS done', () => {
    const previous = new Map<string, RunStatus>([['a', 'running']])
    expect(diffSuccessTransition(previous, [run('a', 'done')]).succeeded).toBe(true)
  })

  it('fires when a run enters review — cezar\'s review gate is a success, not a stall', () => {
    const previous = new Map<string, RunStatus>([['a', 'running']])
    expect(diffSuccessTransition(previous, [run('a', 'review')]).succeeded).toBe(true)
  })

  it('stays silent on first sight, however finished the run is', () => {
    // The cold-boot case: opening the cockpit on a week of finished work is not a moment to
    // congratulate anyone on a run from Tuesday.
    expect(diffSuccessTransition(new Map(), [run('a', 'done'), run('b', 'review')]).succeeded).toBe(false)
  })

  it('stays silent on an unchanged status — a finished run re-announces itself constantly', () => {
    const previous = new Map<string, RunStatus>([['a', 'done']])
    expect(diffSuccessTransition(previous, [run('a', 'done')]).succeeded).toBe(false)
  })

  it('stays silent for failure, cancellation and every non-terminal status', () => {
    const previous = new Map<string, RunStatus>([
      ['a', 'running'],
      ['b', 'running'],
      ['c', 'queued'],
      ['d', 'running'],
    ])
    const result = diffSuccessTransition(previous, [
      run('a', 'failed'),
      run('b', 'cancelled'),
      run('c', 'running'),
      run('d', 'waiting'),
    ])
    expect(result.succeeded).toBe(false)
  })

  it('returns the statuses to remember, dropping runs that are gone', () => {
    const previous = new Map<string, RunStatus>([
      ['a', 'running'],
      ['gone', 'done'],
    ])
    const { statuses } = diffSuccessTransition(previous, [run('a', 'done')])
    expect([...statuses]).toEqual([['a', 'done']])
  })

  it('handles an absent list — the cache is empty before the first fetch lands', () => {
    expect(diffSuccessTransition(new Map(), undefined)).toEqual({
      succeeded: false,
      withPullRequest: false,
      statuses: new Map(),
    })
  })

  it('reports whether the successful run actually opened a PR', () => {
    const previous = new Map<string, RunStatus>([['a', 'running']])
    expect(diffSuccessTransition(previous, [run('a', 'done')]).withPullRequest).toBe(false)
    expect(
      diffSuccessTransition(previous, [
        { ...run('a', 'done'), pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1' },
      ]).withPullRequest,
    ).toBe(true)
  })

  it('prefers the PR when several runs land in one observation', () => {
    const previous = new Map<string, RunStatus>([
      ['a', 'running'],
      ['b', 'running'],
    ])
    const result = diffSuccessTransition(previous, [
      { ...run('a', 'done'), pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1' },
      run('b', 'review'),
    ])
    expect(result).toMatchObject({ succeeded: true, withPullRequest: true })
  })
})

describe('the link', () => {
  it('points at cezar, over https', () => {
    expect(CEZAR_REPO_URL).toBe('https://github.com/open-mercato/cezar')
  })
})
