import { describe, expect, it } from 'vitest'

import { describeFallback, parseFallbackNote } from './fallback-note'

const CODEX_TIMEOUT = 'codex: tool-policy enforcement unavailable — isolated startup verification timed out; check the selected account and model provider. Refusing this restricted step; no model turn was started. Pick Claude Code or Pi for unsupported grants.'
const CODEX_GRANT = 'codex: tool-policy enforcement unavailable — this tool grant is unsupported. Refusing this restricted step; no model turn was started. Pick Claude Code or Pi for unsupported grants.'

describe('parseFallbackNote', () => {
  it('reads the structured field', () => {
    expect(parseFallbackNote({ kind: 'commit-message', runner: 'codex', reason: 'empty answer' }, 'x'))
      .toEqual({ kind: 'commit-message', runner: 'codex', reason: 'empty answer' })
  })

  it('recognises notes recorded before the field, with the runner from the reason', () => {
    expect(parseFallbackNote(undefined, `model naming unavailable — ${CODEX_TIMEOUT}`))
      .toEqual({ kind: 'title', runner: 'codex', reason: CODEX_TIMEOUT })
    expect(parseFallbackNote(undefined, 'commit message named from the files — no cheap model known for pi'))
      .toEqual({ kind: 'commit-message', runner: 'pi', reason: 'no cheap model known for pi' })
    expect(parseFallbackNote(undefined, 'commit message named from the files — empty answer'))
      .toEqual({ kind: 'commit-message', reason: 'empty answer' })
  })

  it('leaves every other note alone, and ignores a malformed field', () => {
    expect(parseFallbackNote(undefined, 'auto-land — nothing to land')).toBeUndefined()
    expect(parseFallbackNote({ kind: 'nope', reason: 'x' }, 'step started')).toBeUndefined()
    expect(parseFallbackNote({ kind: 'title' }, 'step started')).toBeUndefined()
  })
})

describe('describeFallback', () => {
  it('names what fell back for each kind', () => {
    expect(describeFallback({ kind: 'title', reason: 'x' }).headline).toMatch(/Couldn’t name this task automatically — used a fallback title/)
    expect(describeFallback({ kind: 'commit-message', reason: 'x' }).headline).toMatch(/Couldn’t write the commit message — used a list of changed files/)
  })

  it.each([
    ['model naming is off', /turned off on this machine/, undefined],
    ['nothing staged', /no staged changes/, undefined],
    ['no cheap model known for codex', /small, cheap model for it/, '/settings/agents'],
    [CODEX_TIMEOUT, /didn’t start in time/, '/settings/global/accounts'],
    ['codex: tool-policy enforcement unavailable — isolated startup could not be verified; check the selected account and model provider. x', /didn’t start in time/, '/settings/global/accounts'],
    [CODEX_GRANT, /can’t run this short call with its tools locked down/, '/settings/agents'],
    ['empty answer', /empty answer/, undefined],
    ['no answer', /empty answer/, undefined],
    ['unusable answer: hello there', /couldn’t be used/, undefined],
  ])('maps %j to friendly text', (reason, explanation, link) => {
    const copy = describeFallback({ kind: 'title', runner: 'codex', reason })
    expect(copy.explanation).toMatch(explanation)
    expect(copy.link?.to).toBe(link)
  })

  it('falls back to the raw text (no invented explanation) for anything else', () => {
    const copy = describeFallback({ kind: 'commit-message', runner: 'claude', reason: 'spawn claude ENOENT' })
    expect(copy.explanation).toBeUndefined()
    expect(copy.link?.to).toBe('/settings/global/accounts')
  })
})
