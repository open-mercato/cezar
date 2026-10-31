import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { type AutomationListEntry } from '@open-mercato/cezar-api-client'
import { nextRuns } from './next-runs-rail'
import { NextRunsPreview } from './next-runs-preview'
import { occurrencesIn } from './calendar-parts'
import { cliDefinitionOf, fromDefinition, toBody } from './editor-draft'
import { cliOf } from '@/lib/automation-cli'
import { triggerLabel } from '@/lib/automation-format'

afterEach(cleanup)
const at = Date.parse('2026-10-30T00:00:00Z')
const schedule = { type: 'weekdays' as const, hour: 9, minute: 0 }
const schedules = [schedule, { type: 'weekly' as const, day: 5, hour: 16, minute: 0 }, { type: 'daily' as const, hour: 9, minute: 0 }]
const definition: AutomationListEntry = { id: 'a', revision: 1, name: 'Shared', enabled: true, kind: 'schedule', schedule, schedules,
  task: { prompt: 'One task', autonomous: true }, createdAt: '', updatedAt: '', counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 }, runs7d: 0 }

describe('#1818 union consumers', () => {
  it('round trips draft and JSON Copy CLI without dropping schedules', () => {
    const draft = fromDefinition(definition)
    expect(toBody(draft).schedules).toEqual(schedules)
    const cli = cliOf(cliDefinitionOf(draft))
    expect(cli).toContain('automation create --json')
    expect(JSON.parse(cli.slice(cli.indexOf("'") + 1, -1)).schedules).toEqual(schedules)
    expect(triggerLabel(definition)).toContain('Fridays at 16:00')
  })
  it('preview and rail show both distinct times, with coincident entries deduplicated', () => {
    render(<NextRunsPreview kind="schedule" schedule={schedule} schedules={schedules} intervalSeconds={300} timeZone="UTC" now={at} />)
    const labels = [...document.querySelectorAll('[data-slot="next-run"]')].map(row => row.textContent)
    expect(labels[0]).toContain('Fri 09:00'); expect(labels[1]).toContain('Fri 16:00')
    expect(document.querySelectorAll('[data-slot="next-run"]')).toHaveLength(5)
    expect(nextRuns([definition], at, 'UTC', 2).map(row => row.at)).toEqual([at + 9 * 3_600_000, at + 16 * 3_600_000])
    expect(occurrencesIn([definition], at, at + 86_400_000, 'UTC').map(row => row.at)).toEqual([at + 9 * 3_600_000, at + 16 * 3_600_000])
  })
})
