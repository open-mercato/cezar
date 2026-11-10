import { describe, expect, it } from 'vitest'

import { render, screen } from '@testing-library/react'

import { accountPart, LIVE_USAGE_STALE_MS, LiveUsage, liveUsageParts, timeLeft } from './live-usage'

const NOW = Date.parse('2026-10-23T08:00:00.000Z')

describe('liveUsageParts', () => {
  it('renders plan windows and context fill like the Claude status line', () => {
    expect(
      liveUsageParts(
        {
          limits: [
            { window: 'five_hour', utilization: 0.17, resetsAt: '2026-10-23T10:19:00.000Z' },
            { window: 'seven_day', utilization: 0.2, resetsAt: '2026-10-25T19:00:00.000Z' },
          ],
          contextTokens: 416_000,
          contextWindow: 1_000_000,
          at: '2026-10-23T08:00:00.000Z',
        },
        NOW,
      ),
    ).toEqual([
      { text: '5h 83% left 2h19m', tone: 'success' },
      { text: '7d 80% left 2d11h', tone: 'success' },
      { text: 'CTX 416.0k 42%', tone: 'success' },
    ])
  })

  it('turns amber from half used and red from 80%', () => {
    const usage = (utilization: number, contextTokens: number) =>
      liveUsageParts(
        {
          limits: [{ window: 'five_hour', utilization, resetsAt: '2026-10-23T09:00:00.000Z' }],
          contextTokens,
          contextWindow: 1000,
          at: '2026-10-23T08:00:00.000Z',
        },
        NOW,
      ).map((part) => part.tone)
    expect(usage(0.49, 499)).toEqual(['success', 'success'])
    expect(usage(0.5, 500)).toEqual(['warning', 'warning'])
    expect(usage(0.8, 800)).toEqual(['danger', 'danger'])
  })

  it('drops a window that already reset and the percent when the window size is unknown', () => {
    expect(
      liveUsageParts(
        {
          limits: [{ window: 'five_hour', utilization: 0.9, resetsAt: '2026-10-23T07:00:00.000Z' }],
          contextTokens: 900,
          at: '2026-10-23T08:00:00.000Z',
        },
        NOW,
      ),
    ).toEqual([{ text: 'CTX 900', tone: 'success' }])
    expect(liveUsageParts(undefined, NOW)).toEqual([])
  })

  it('reads the account from the identity route: org first, the email on hover', () => {
    const details = (fields: { label: string; value: string }[]) => ({ available: true, fields })
    expect(accountPart(details([{ label: 'Email', value: 'me@example.com' }, { label: 'Organization', value: 'WP-Stars' }]))).toEqual({
      text: 'WP-Stars',
      tone: 'neutral',
      title: 'me@example.com',
    })
    expect(accountPart(details([{ label: 'Email', value: 'me@example.com' }]))?.text).toBe('me@example.com')
    expect(accountPart({ available: false, fields: [] })).toBeUndefined()
    expect(accountPart(undefined)).toBeUndefined()
  })

  it('formats time left', () => {
    expect(timeLeft(42 * 60_000)).toBe('42m')
    expect(timeLeft(65 * 60_000)).toBe('1h05m')
    expect(timeLeft(-1)).toBe('0m')
  })
})

describe('LiveUsage', () => {
  it('dims gauges read more than a few minutes ago, never the account', () => {
    const at = new Date(Date.now() - LIVE_USAGE_STALE_MS - 60_000).toISOString()
    render(
      <LiveUsage
        usage={{ contextTokens: 900, at }}
        account={{ text: 'WP-Stars', tone: 'neutral', title: 'me@example.com' }}
      />,
    )
    expect(screen.getByText('CTX 900').hasAttribute('data-stale')).toBe(true)
    expect(screen.getByText('CTX 900').getAttribute('title')).toMatch(/^as of /)
    expect(screen.getByText('WP-Stars').hasAttribute('data-stale')).toBe(false)
    expect(screen.getByText('WP-Stars').getAttribute('title')).toBe('me@example.com')
  })
})
