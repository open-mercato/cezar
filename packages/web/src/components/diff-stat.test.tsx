import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DiffStatLabel } from '@/components/diff-stat'

afterEach(cleanup)

const label = () => screen.getByTestId('stat-host').querySelector('[data-slot="diff-stat"]') as HTMLElement

function renderStat(stat: Parameters<typeof DiffStatLabel>[0]['stat']) {
  render(
    <div data-testid="stat-host">
      <DiffStatLabel stat={stat} />
    </div>
  )
  return label()
}

describe('DiffStatLabel', () => {
  it('shows the adds/dels pair and spells the counts out in the tooltip', () => {
    const el = renderStat({ adds: 128, dels: 14, files: 3 })
    expect(el.textContent).toBe('+128 −14')
    expect(el.title).toBe('+128 −14 across 3 files')
  })

  it('says "file" in the singular for a one-file diff', () => {
    expect(renderStat({ adds: 1, dels: 0, files: 1 }).title).toBe('+1 −0 across 1 file')
  })

  it('carries no repointed marker on an ordinary stat', () => {
    const el = renderStat({ adds: 10, dels: 2, files: 3 })
    expect(el.getAttribute('data-repointed')).toBeNull()
    expect(el.className).not.toContain('underline')
    // No aria-label either: on a plain stat the tooltip only restates the visible
    // text, so overriding the accessible name would make it worse, not better.
    expect(el.getAttribute('aria-label')).toBeNull()
  })

  /**
   * #751: a review/QA task's numbers are measured against the branch it checked out, because the agent
   * checked another branch out into the worktree. The number is honest; the surface
   * has to explain WHY it is smaller than the one that used to be there.
   */
  it('explains a repointed stat in the tooltip and marks it for the surfaces', () => {
    const el = renderStat({ adds: 1, dels: 0, files: 1, repointed: true })
    expect(el.getAttribute('data-repointed')).toBe('true')
    expect(el.title).toBe(
      "+1 −0 across 1 file — measured against another branch checked out in this task's worktree, as this task found it"
    )
    // Discoverable without a hover-only affordance being the only signal.
    expect(el.className).toContain('cursor-help')
    expect(el.className).toContain('decoration-dotted')
    // `title` is unreliable for screen readers and unreachable on touch, and here it
    // carries meaning rather than a restatement — so the caveat is in the a11y name too.
    expect(el.getAttribute('aria-label')).toBe(el.title)
  })

  /**
   * `diffStat` is a turn-end snapshot that is never recomputed or cleared afterwards —
   * not when the run finishes, and not when retention reclaims the worktree. So the
   * caveat may outlive the checkout that caused it, and must describe what was true when
   * the numbers were measured rather than assert a live worktree state.
   */
  it('scopes the caveat to when the numbers were measured, not to the worktree now', () => {
    const title = renderStat({ adds: 1, dels: 0, files: 1, repointed: true }).title
    expect(title).toContain('measured against another branch checked out')
    // No present-tense claim about a worktree that may already have been reclaimed.
    expect(title).not.toContain('has another branch checked out')
  })

  it('still renders the real numbers when they are all zero and repointed', () => {
    const el = renderStat({ adds: 0, dels: 0, files: 0, repointed: true })
    expect(el.textContent).toBe('+0 −0')
    expect(el.getAttribute('data-repointed')).toBe('true')
  })
})
