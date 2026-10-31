import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ModeSwitch } from './mode-switch'

afterEach(cleanup)

function renderSwitch(entry: string, manager: boolean, attention = false) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ModeSwitch manager={manager} attention={attention} />
    </MemoryRouter>,
  )
}

describe('ModeSwitch', () => {
  it('marks Code current and stays put in Code mode', () => {
    renderSwitch('/p/alpha/git?x=1', false)
    const code = screen.getByRole('link', { name: 'Code' })
    expect(code.getAttribute('aria-current')).toBe('page')
    expect(code.getAttribute('href')).toBe('/p/alpha/git?x=1')
    expect(screen.getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/manager')
  })

  it('leads Code to the bare root, which restores the last project page', () => {
    renderSwitch('/manager/global', true)
    expect(screen.getByRole('link', { name: 'Code' }).getAttribute('href')).toBe('/')
    expect(screen.getByRole('link', { name: 'Manager' }).getAttribute('aria-current')).toBe('page')
  })

  it('carries the dot only with something waiting, and names it', () => {
    renderSwitch('/', false)
    expect(document.querySelector('[data-slot="manager-attention"]')).toBeNull()
    cleanup()
    renderSwitch('/', false, true)
    expect(document.querySelector('[data-slot="manager-attention"]')).not.toBeNull()
    expect(screen.getByRole('link', { name: /Manager.*needs you/ })).toBeTruthy()
  })
})
