import { describe, expect, it } from 'vitest'

import type { RunArtifact } from '@open-mercato/cezar-api-client'

import { buildTranscriptRows, placeArtifactRows, type TranscriptSection } from './session-transcript'

const at = (minute: number) => `2026-10-22T10:${String(minute).padStart(2, '0')}:00.000Z`
const art = (name: string, minute: number): RunArtifact => ({ name, kind: 'json', size: 1, updatedAt: at(minute) })

const turn = (id: string, minute: number, completed: number): TranscriptSection => ({
  id,
  userMessage: { text: id, ts: at(minute) },
  startedAt: at(minute),
  completedAt: at(completed),
  entries: [],
})

const layout = (sections: TranscriptSection[], artifacts: RunArtifact[]) =>
  placeArtifactRows(buildTranscriptRows(sections, 'r1'), sections, artifacts).map((row) =>
    row.content.kind === 'artifacts' ? `cards:${row.content.artifacts.map((a) => a.name).join(',')}` : row.key,
  )

describe('placeArtifactRows (#2037)', () => {
  const sections = [turn('t1', 0, 9), turn('t2', 10, 19), turn('t3', 20, 29)]

  it('puts each card under the turn that produced it, not below the whole transcript', () => {
    expect(layout(sections, [art('a.json', 5), art('b.json', 25)])).toEqual([
      't1:user', 't1:turn-time', 'cards:a.json',
      't2:user', 't2:turn-time',
      't3:user', 't3:turn-time', 'cards:b.json',
    ])
  })

  it('groups several files of one turn and keeps them oldest first', () => {
    expect(layout(sections, [art('z.json', 7), art('a.json', 3)]).filter((k) => k.startsWith('cards'))).toEqual(['cards:a.json,z.json'])
  })

  it('a rewritten file re-homes to the turn that last wrote it', () => {
    expect(layout(sections, [art('a.json', 22)]).indexOf('cards:a.json')).toBe(layout(sections, []).length)
  })

  it('trails the transcript when no turn carries a stamp, and drops supporting files', () => {
    const bare: TranscriptSection[] = [{ id: 't1', entries: [], userMessage: { text: 'x' } }]
    const out = layout(bare, [art('a.json', 5), { ...art('shots/s.png', 5), kind: 'image' }])
    expect(out).toEqual(['t1:user', 'cards:a.json'])
  })

  it('leaves rows untouched with no artifacts', () => {
    expect(layout(sections, [])).toEqual(['t1:user', 't1:turn-time', 't2:user', 't2:turn-time', 't3:user', 't3:turn-time'])
  })
})
