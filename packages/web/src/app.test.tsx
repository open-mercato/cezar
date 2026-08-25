import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { implementation } = vi.hoisted(() => ({
  implementation: vi.fn(() => <div data-testid="cockpit-implementation" />),
}))

vi.mock('./cockpit-implementation', () => ({
  CezarCockpitImplementation: implementation,
}))

import { App } from './app'

afterEach(() => {
  cleanup()
  implementation.mockClear()
})

it('renders the shared private cockpit implementation from the standalone browser app', () => {
  const rootElement = document.createElement('div')
  document.body.append(rootElement)

  render(<App apiBase="https://cezar.example" rootElement={rootElement} />, { container: rootElement })

  expect(screen.getByTestId('cockpit-implementation')).toBeTruthy()
  expect(implementation).toHaveBeenCalledWith(
    expect.objectContaining({ rootElement }),
    undefined,
  )
})
