import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { managerKeys } from '@/api/managers'
import { managerFixture } from '@/routes/manager/manager-fixtures'

import { managerHref, ModeSwitch, rememberManagerLocation } from './mode-switch'

afterEach(cleanup)

function renderSwitch(entry: string, manager: boolean, attention = false, managers?: ReturnType<typeof managerFixture>[]) {
  const client = new QueryClient()
  if (managers) client.setQueryData(managerKeys.list, { managers })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ModeSwitch manager={manager} attention={attention} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ModeSwitch', () => {
  it('marks Tasks current and stays put in Tasks mode', () => {
    renderSwitch('/p/alpha/git?x=1', false)
    const code = screen.getByRole('link', { name: 'Tasks' })
    expect(code.getAttribute('aria-current')).toBe('page')
    expect(code.getAttribute('href')).toBe('/p/alpha/git?x=1')
    expect(screen.getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/manager')
  })

  it('leads Tasks to the bare root, which restores the last project page', () => {
    renderSwitch('/manager/global', true)
    expect(screen.getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/')
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

  it('tells a waiting approval from plain news, in colour and in words', () => {
    renderSwitch('/', false, true, [managerFixture({ unread: 2 })])
    let dot = document.querySelector<HTMLElement>('[data-slot="manager-attention"]')!
    expect(dot.dataset.attention).toBe('unread')
    expect(dot.firstElementChild?.className).toContain('bg-info')
    expect(screen.getByRole('link', { name: /Manager.*unread/ })).toBeTruthy()
    cleanup()
    renderSwitch('/', false, true, [managerFixture({ id: 'a', unread: 2 }), managerFixture({ id: 'b', pendingQuestions: 1 })])
    dot = document.querySelector<HTMLElement>('[data-slot="manager-attention"]')!
    expect(dot.dataset.attention).toBe('needs-you')
    expect(dot.firstElementChild?.className).toContain('bg-pending')
    expect(screen.getByRole('link', { name: /Manager.*needs you/ })).toBeTruthy()
  })
})

describe('managerHref', () => {
  afterEach(() => sessionStorage.clear())

  it('is /manager until this tab has been in Manager', () => {
    expect(managerHref(undefined)).toBe('/manager')
  })

  it('returns to the chat or list this tab left', () => {
    rememberManagerLocation('/manager/b')
    expect(managerHref(['a', 'b'])).toBe('/manager/b')
    rememberManagerLocation('/manager?all=1')
    expect(managerHref(['a', 'b'])).toBe('/manager?all=1')
  })

  it('never returns to setup, nor to a manager the list no longer has', () => {
    rememberManagerLocation('/manager/b')
    rememberManagerLocation('/manager/new')
    expect(managerHref(['a', 'b'])).toBe('/manager/b')
    expect(managerHref(['a'])).toBe('/manager')
    // The list still loading is no reason to doubt it.
    expect(managerHref(undefined)).toBe('/manager/b')
  })

  it('ignores anything that is not a manager location', () => {
    sessionStorage.setItem('cez-last-manager', 'https://example.com/')
    expect(managerHref(['a'])).toBe('/manager')
  })
})

describe('ModeSwitch in Manager mode', () => {
  it('leads Manager to the remembered place from Tasks, and stays put inside Manager', () => {
    render(
      <MemoryRouter initialEntries={['/p/alpha/']}>
        <ModeSwitch manager={false} attention={false} managerTo="/manager/b" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/manager/b')
    cleanup()
    renderSwitch('/manager/a', true)
    expect(screen.getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/manager/a')
  })
})
