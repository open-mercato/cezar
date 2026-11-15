import { describe, expect, it } from 'vitest'

import { COMPOSER_TIPS, OPTIONS_TRIGGER_ANCHOR, TIPS_PER_VISIT, allTipsSeen, markTipSeen, tipsForVisit } from './composer-tips'

const anchors = (...ids: string[]) => new Set(COMPOSER_TIPS.filter((tip) => ids.includes(tip.id)).map((tip) => tip.anchor))
const ALL = new Set(COMPOSER_TIPS.map((tip) => tip.anchor))

describe('composer tips (spec 2026-10-26-first-run-onboarding § Composer tips)', () => {
  it('explains two controls per visit, in teaching order, skipping the ones already closed', () => {
    expect(tipsForVisit({ seen: undefined, off: undefined, present: ALL }).map((tip) => tip.id)).toEqual(['slash-skills', 'source'])
    expect(tipsForVisit({ seen: ['slash-skills'], off: false, present: ALL }).map((tip) => tip.id)).toEqual(['source', 'worktree'])
    expect(TIPS_PER_VISIT).toBe(2)
  })

  it('never points at a control that is not on screen', () => {
    // No Options trigger yet (the composer is still loading), no templates either.
    const present = anchors('slash-skills', 'source', 'model', 'attachments')
    expect(tipsForVisit({ seen: ['slash-skills', 'source'], off: false, present }).map((tip) => tip.id)).toEqual(['model', 'attachments'])
  })

  it('the settings behind Options are taught at the trigger — the only anchor a closed popover leaves', () => {
    // Design Proposal 5: isolation, mode, variants, base branch and the schedule live in the panel.
    for (const id of ['worktree', 'autonomous', 'options']) {
      expect(COMPOSER_TIPS.find((tip) => tip.id === id)?.anchor).toBe(OPTIONS_TRIGGER_ANCHOR)
    }
    for (const tip of COMPOSER_TIPS) {
      expect(tip.anchor).not.toMatch(/worktree-toggle|autonomous-toggle|variants-pill|base-pill|start-time-trigger|dispatch-toggle|ask-toggle|generate-followups-toggle/)
    }
    const present = new Set([OPTIONS_TRIGGER_ANCHOR])
    expect(tipsForVisit({ seen: ['worktree'], off: false, present }).map((tip) => tip.id)).toEqual(['autonomous', 'options'])
  })

  it('shows nothing once the user turned tips off, unless they ask for a replay', () => {
    expect(tipsForVisit({ seen: [], off: true, present: ALL })).toEqual([])
    expect(tipsForVisit({ seen: COMPOSER_TIPS.map((tip) => tip.id), off: true, present: ALL, replay: true })).toHaveLength(COMPOSER_TIPS.length)
  })

  it('a replay walks every present tip from the start, closed or not', () => {
    const present = anchors('slash-skills', 'worktree', 'model')
    expect(tipsForVisit({ seen: ['slash-skills', 'worktree', 'model'], off: false, present, replay: true }).map((tip) => tip.id)).toEqual([
      'slash-skills', 'worktree', 'autonomous', 'model', 'options',
    ])
  })

  it('runs out when every tip on screen has been closed', () => {
    const present = anchors('slash-skills', 'source')
    expect(tipsForVisit({ seen: ['slash-skills', 'source'], off: false, present })).toEqual([])
    expect(allTipsSeen(['slash-skills', 'source'], present)).toBe(true)
    expect(allTipsSeen(['slash-skills'], present)).toBe(false)
  })

  it('keeps the seen list bounded to what the ui-state schema accepts, newest last', () => {
    const many = Array.from({ length: 50 }, (_, at) => `tip-${at}`)
    const next = markTipSeen(many, 'source')
    expect(next).toHaveLength(50)
    expect(next.at(-1)).toBe('source')
    expect(next[0]).toBe('tip-1')
    // Closing a tip again moves it to the end rather than listing it twice.
    expect(markTipSeen(['a', 'b'], 'a')).toEqual(['b', 'a'])
  })

  it('every tip has a unique id, and only the Options tips share an anchor', () => {
    expect(new Set(COMPOSER_TIPS.map((tip) => tip.id)).size).toBe(COMPOSER_TIPS.length)
    const ownAnchor = COMPOSER_TIPS.filter((tip) => tip.anchor !== OPTIONS_TRIGGER_ANCHOR)
    expect(new Set(ownAnchor.map((tip) => tip.anchor)).size).toBe(ownAnchor.length)
  })
})
