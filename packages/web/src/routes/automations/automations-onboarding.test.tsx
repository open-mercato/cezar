import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AutomationsOnboarding } from './automations-onboarding'
import { response, stubResizeObserver } from './automations-list.fixtures'

/**
 * The automations explainer (spec 2026-10-26-first-run-onboarding § Automations): each trigger
 * tile opens the editor on that trigger, a GitHub tile without `gh` sends the user to sign in
 * first, and the picture guide pages through the four things to know.
 */

beforeEach(() => {
  stubResizeObserver()
})
afterEach(() => {
  cleanup()
})

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

function renderOnboarding(available = true) {
  render(
    <MemoryRouter initialEntries={['/automations']}>
      <Routes>
        <Route path="*" element={<><AutomationsOnboarding data={response({ automations: [], available, ...(available ? {} : { reason: 'gh not installed' }) })} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

const location = () => screen.getByTestId('location').textContent

describe('AutomationsOnboarding', () => {
  it('opens the editor on the trigger the tile names', () => {
    renderOnboarding()
    fireEvent.click(screen.getByRole('button', { name: /On a schedule/ }))
    expect(location()).toBe('/automations/new?kind=schedule')
  })

  it('the schedule is the recommended start; GitHub and tracker tiles name their trigger', () => {
    renderOnboarding()
    expect(screen.getByRole('button', { name: /On a schedule/ }).getAttribute('data-recommended')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /When GitHub changes/ }))
    expect(location()).toBe('/automations/new?kind=github')
  })

  it('the tracker tile opens the Jira / Linear trigger', () => {
    renderOnboarding()
    fireEvent.click(screen.getByRole('button', { name: /When an issue moves/ }))
    expect(location()).toBe('/automations/new?kind=tracker')
  })

  it('without the GitHub CLI the GitHub tile says so and leads to the sign-in page', () => {
    renderOnboarding(false)
    const tile = screen.getByRole('button', { name: /When GitHub changes/ })
    expect(tile.textContent).toContain('Sign in to the GitHub CLI first.')
    fireEvent.click(tile)
    expect(location()).toBe('/github')
  })

  it('"See it in pictures" opens the guide, which pages through four ideas and ends on New automation', () => {
    renderOnboarding()
    fireEvent.click(screen.getByRole('button', { name: 'See it in pictures' }))
    const page = () => document.querySelector('[data-slot="automations-guide-page"]')?.getAttribute('data-page')
    expect(page()).toBe('prompt')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(page()).toBe('tasks')
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /New automation/ }))
    expect(location()).toBe('/automations/new')
  })
})
