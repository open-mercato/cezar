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
// carry no scoped source keys.
const baselines: Record<string, string> = {
  bashAndScreenshot: '91fd0a357a79d1ac9e9335510140c7f961a2af124d9fd70780453218d1df4ab6',
  failedAndDenied: 'e351dc037b037ed9e8c5b85b507d0e0481497f75f63e6fca15378159872ce560',
  textTurn: 'e90e54b2576e89d382c71fe5fbb5df6aaaf946dfc878766bbc72d3be75456874',
  thinkingEditWriteTodo: '3948ee5283116cdbebf29bdf899e63dbec66cc3de4dc0772e30d90ea9e8a1bc6',
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
