import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GitAction, GitActionId } from '@/lib/git-actions'

import { GitActions } from './git-toolbar'

/** The git button's busy state: spinner copy, disabled, and no second click while in flight. */

afterEach(cleanup)

const button = () => document.querySelector('[data-slot="git-button"] button') as HTMLButtonElement

function renderStep(action: GitAction, pending: GitActionId | null) {
  const onAction = vi.fn()
  render(<GitActions action={action} pending={pending} onAction={onAction} />)
  return onAction
}

describe('GitActions busy state', () => {
  it('Commit and push stays busy through the push that follows its commit', () => {
    const onAction = renderStep({ id: 'commit-push', label: 'Commit and push', enabled: true }, 'push')
    expect(button().textContent).toBe('Pushing…')
    expect(button().disabled).toBe(true)
    expect(button().getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button())
    expect(onAction).not.toHaveBeenCalled()
  })

  it('a draft PR in flight spins the Create PR button and locks its chevron', () => {
    renderStep(
      {
        id: 'create-pr',
        label: 'Create PR',
        enabled: true,
        alternatives: [{ id: 'create-draft-pr', label: 'Create draft PR', enabled: true }],
      },
      'create-draft-pr',
    )
    const [main, chevron] = document.querySelectorAll<HTMLButtonElement>('[data-slot="git-button"] button')
    expect(main?.textContent).toBe('Creating draft PR…')
    expect(chevron?.disabled).toBe(true)
  })

  it('any step in flight makes the shown button busy, under the in-flight step’s label', () => {
    // Mid-turn the policy can move on (Commit and push → Push); the agent is still doing it.
    const onAction = renderStep({ id: 'push', label: 'Push', enabled: true }, 'commit-push')
    expect(button().textContent).toBe('Committing and pushing…')
    expect(button().disabled).toBe(true)
    fireEvent.click(button())
    expect(onAction).not.toHaveBeenCalled()
  })
})
