import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SkillsDock } from './skills-dock'

afterEach(cleanup)

const dock = () => document.querySelector('[data-slot="skills-dock"]')
const names = () => document.querySelector('[data-slot="skills-names"]')?.textContent

describe('SkillsDock', () => {
  it('renders nothing when the run invoked no skill', () => {
    render(<SkillsDock skills={[]} />)
    expect(dock()).toBeNull()
  })

  it('names the one skill governing the run, in the singular', () => {
    render(<SkillsDock skills={[{ id: 's1', name: 'om-auto-create-pr' }]} />)
    expect(dock()?.textContent).toContain('Skill')
    expect(names()).toBe('· om-auto-create-pr')
  })

  it('lists several skills in the plural', () => {
    render(
      <SkillsDock
        skills={[
          { id: 's1', name: 'om-auto-create-pr' },
          { id: 's2', name: 'om-code-review' },
        ]}
      />,
    )
    expect(dock()?.textContent).toContain('Skills')
    expect(names()).toBe('· om-auto-create-pr · om-code-review')
  })

  /**
   * The whole point of the dock (#1202): it must not restate the Agents dock's odometer. A
   * `Skill` call settles the moment its instructions return, so any `N/M` here would read as
   * "the skill is finished" while the agent is still following it.
   */
  it('shows no N/M progress and no per-skill glyph', () => {
    render(<SkillsDock skills={[{ id: 's1', name: 'om-auto-create-pr' }]} />)
    expect(dock()!.textContent).not.toMatch(/\d\s*\/\s*\d/)
    expect(document.querySelector('[data-slot="agents-count"]')).toBeNull()
    expect(document.querySelector('[data-slot="agent-glyph"]')).toBeNull()
  })
})
