import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'
import bashAndScreenshot from '../../../../cezar/src/core/__fixtures__/claude/bash-and-screenshot.expected.json'
import failedAndDenied from '../../../../cezar/src/core/__fixtures__/claude/failed-and-denied.expected.json'
import textTurn from '../../../../cezar/src/core/__fixtures__/claude/text-turn.expected.json'
import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'

import { buildTranscriptRows, mainTranscriptSections } from './session-transcript'
import { liveTurnStart } from './task-thread'
import { reduceThread } from './thread-state'

const fixtures: [string, RunEvent[]][] = [
  ...Object.entries({ bashAndScreenshot, failedAndDenied, textTurn, thinkingEditWriteTodo }).map(([name, events]): [string, RunEvent[]] => [
    name, events.map((event, index) => ({ seq: index + 1, ts: '2026-07-14T12:00:00.000Z', ...event }) as RunEvent),
  ]),
  ...['thread-run', 'subagents-run'].map((name): [string, RunEvent[]] => [
    name, readFileSync(resolve(import.meta.dirname, `../../../e2e/fixtures/${name}.ndjson`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as RunEvent),
  ]),
]

// Exact reducer/row fingerprints, including every prefix and suffix; ordinary items
// carry no scoped source keys. Includes main's sessionModel metadata; removing that
// field reproduces the pre-merge fingerprints without changing turns, rows or clocks.
const baselines: Record<string, string> = {
  bashAndScreenshot: 'f2fc913a0e4a0e27e4a3f01ad1225c0eab409826010ee046adf0347a903598ff',
  failedAndDenied: 'eaf60948e943cef9419e375eccda330cea8c9b158cc3fbca42daa480c7c1b528',
  textTurn: 'b1c8c2f0853be81c96a86519cd944716fc1f18b48eec712c2ccd1d1d940235ed',
  thinkingEditWriteTodo: '9e506f91683a5b7953ddec4a2309e9cd5c9c7b132755939086856faaa9ad3aa1',
  'thread-run': '5a57c9f529bd6038234f3795dead57dbf85e31730a06e7b32c66c5ef18acd9d9',
  'subagents-run': '88896b056e963f098f635dbe8166e50e2563837f12a4bdcf89cf2df74d9a3530',
}

describe('ordinary transcript compatibility', () => {
  it.each(fixtures)('guard: preserves exact turns, rows and clocks for every prefix and suffix of %s', (name, events) => {
    const run = { task: '', startedAt: '2026-07-14T09:00:00.000Z' } as ApiRun
    const digest = createHash('sha256')
    for (const activeTurn of [false, true]) {
      for (let cut = 0; cut <= events.length; cut += 1) {
        for (const window of [events.slice(0, cut), events.slice(cut)]) {
          const thread = reduceThread(window, { activeTurn, runner: 'claude' })
          const rows = buildTranscriptRows(mainTranscriptSections(run, thread), 'ordinary')
          digest.update(JSON.stringify({ thread, rows }))
          const last = thread.turns.at(-1)
          const expected = last === undefined ? run.startedAt
            : last.completed === undefined ? last.startedAt ?? run.startedAt : last.completed.ts ?? run.startedAt
          expect(liveTurnStart(run, thread)).toBe(expected)
        }
      }
    }
    expect(digest.digest('hex')).toBe(baselines[name])
  })
})
