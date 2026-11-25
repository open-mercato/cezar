import { describe, expect, it } from 'vitest'
import { approxPp, resetTime } from './plan-usage'

describe('plan-usage formatting', () => {
  it('shows a zero share as a dash, not "≈ 0%" (QA F4)', () => {
    expect(approxPp(0)).toBe('—')
    expect(approxPp(0.04)).toBe('≈ <0.1%')
    expect(approxPp(8)).toBe('≈ 8%')
  })

  it('names the day of a weekly reset, only the clock of a 5-hour one (QA F6)', () => {
    const iso = '2026-11-26T08:00:00.000Z'
    const weekly = resetTime(iso, 'weekly')
    expect(weekly).toContain(resetTime(iso, 'five-hour'))
    expect(weekly.length).toBeGreaterThan(resetTime(iso, 'five-hour').length + 4)
  })
})
