import { describe, expect, it } from 'vitest'

import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'
import {
  CEZAR_REPO_URL,
  STAR_TOAST_MESSAGE,
  STAR_TOAST_MESSAGE_NO_PR,
  STAR_TOAST_SEEN_KEY,
  diffSuccessTransition,
  formatStarCount,
  hasSeenStarToast,
  markStarToastSeen,
  starToastMessage,
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

describe('the one-time flag', () => {
  const store = (initial: Record<string, string> = {}) => {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      map,
    }
  }

  it('reports unseen on a fresh store, and seen once marked', () => {
    const s = store()
    expect(hasSeenStarToast(s)).toBe(false)
    markStarToastSeen(s)
    expect(hasSeenStarToast(s)).toBe(true)
    expect(s.map.has(STAR_TOAST_SEEN_KEY)).toBe(true)
  })

  it('fails CLOSED: no storage at all reads as already seen', () => {
    // The asymmetry is the point. "Seen" costs one user the ask; "not seen" makes a single
    // request repeat on every successful run forever.
    expect(hasSeenStarToast(null)).toBe(true)
  })

  it('takes null — not undefined — as "no storage", so a default cannot swallow the signal', () => {
    // `undefined` would re-trigger the default parameter and hand back the real localStorage,
    // turning the fail-closed branch into dead code without a single test going red.
    expect(() => markStarToastSeen(null)).not.toThrow()
  })

  it('fails CLOSED: a store that throws on read reads as already seen', () => {
    expect(
      hasSeenStarToast({
        getItem: () => {
          throw new Error('SecurityError')
        },
      }),
    ).toBe(true)
  })

  it('never throws when the write fails — a full quota must not take the cockpit down', () => {
    expect(() =>
      markStarToastSeen({
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
      }),
    ).not.toThrow()
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

describe('the copy', () => {
  it('says the thing the brief asked it to say', () => {
    expect(STAR_TOAST_MESSAGE).toContain('🎉')
    expect(STAR_TOAST_MESSAGE).toMatch(/star/i)
    expect(STAR_TOAST_MESSAGE).toMatch(/find it/i)
  })

  it('only claims a PR when there is one — most first runs never open one', () => {
    expect(starToastMessage(true)).toBe(STAR_TOAST_MESSAGE)
    expect(starToastMessage(true)).toMatch(/PR/)
    expect(starToastMessage(false)).toBe(STAR_TOAST_MESSAGE_NO_PR)
    expect(starToastMessage(false)).not.toMatch(/\bPR\b/)
  })

  it('keeps the ask itself word-for-word identical — only the opening clause moves', () => {
    const ask = 'If cezar saved you time, a star helps others find it'
    expect(STAR_TOAST_MESSAGE).toContain(ask)
    expect(STAR_TOAST_MESSAGE_NO_PR).toContain(ask)
  })

  it('promises nothing in return — a request, not a transaction', () => {
    for (const copy of [STAR_TOAST_MESSAGE, STAR_TOAST_MESSAGE_NO_PR]) {
      expect(copy).not.toMatch(/\b(unlock|reward|free|upgrade|pro|premium|trial)\b/i)
    }
  })

  it('points at cezar, over https', () => {
    expect(CEZAR_REPO_URL).toBe('https://github.com/open-mercato/cezar')
  })
})
