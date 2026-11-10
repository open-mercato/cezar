import { describe, expect, it } from 'vitest'

import { agentTime, dayName, dayTime, logTime, relativeIn, resultTone, statusLabel, statusTone, timeOnly, triggerLabel, usd } from './automation-format'

const WARSAW = 'Europe/Warsaw'
const NOW = Date.parse('2026-09-16T08:24:00Z') // Wed 10:24 Warsaw

describe('automation-format', () => {
  it('renders day and time in the server zone', () => {
    expect(dayTime('2026-09-17T02:00:00Z', WARSAW)).toBe('Thu 04:00')
    expect(timeOnly('2026-09-17T02:00:00Z', WARSAW)).toBe('04:00')
    expect(dayName(1)).toBe('Mon')
    expect(dayName(7)).toBe('Sun')
    expect(dayTime('2026-09-17T02:00:00Z', 'Mars/Olympus')).toBe('')
  })

  it('stamps a log row with the weekday within six days and the date beyond', () => {
    expect(logTime('2026-09-16T02:00:00Z', WARSAW, NOW)).toBe('Wed 04:00')
    expect(logTime('2026-09-08T02:00:00Z', WARSAW, NOW)).toBe('8 Sep 04:00')
  })

  it('says how far away an instant is', () => {
    expect(relativeIn(NOW + 12 * 60_000, NOW)).toBe('in 12m')
    expect(relativeIn(NOW + 3 * 3_600_000, NOW)).toBe('in 3h')
    expect(relativeIn(NOW + 2 * 86_400_000, NOW)).toBe('in 2d')
    expect(relativeIn(NOW - 1, NOW)).toBe('in 0m')
  })

  it('formats agent time and dollars the way the design does', () => {
    expect(agentTime(4 * 3600 + 12 * 60)).toBe('4h 12m')
    expect(agentTime(12 * 60)).toBe('12m')
    expect(agentTime(0)).toBe('0m')
    expect(usd(13.4)).toBe('$13.4')
    expect(usd(2.41)).toBe('$2.41')
    expect(usd(0)).toBe('$0.00')
  })

  it('maps run states to dots and words', () => {
    expect(statusTone('done')).toBe('success')
    expect(statusTone('running')).toBe('pending')
    expect(statusTone('failed')).toBe('danger')
    expect(statusTone('review')).toBe('violet')
    expect(statusLabel('review')).toBe('needs review')
    expect(statusLabel('done')).toBe('done')
    expect(resultTone('catch-up')).toBe('success')
    expect(resultTone('skipped')).toBe('neutral')
    expect(resultTone('failed')).toBe('danger')
  })

  it('labels a trigger per kind', () => {
    expect(triggerLabel({ kind: 'github', events: ['issue.opened'], intervalSeconds: 300 })).toBe('on issue.opened · every 5 min')
    expect(triggerLabel({ kind: 'schedule', schedule: { type: 'weekdays', hour: 7, minute: 30 } })).toBe('weekdays at 07:30')
  })
})
