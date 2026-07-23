import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderStatusResponse } from '@/api/types'
import { ProviderBanner } from './provider-banner'

const DEFINITIVE_MISSING: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected' },
    { provider: 'codex', status: 'not-installed' },
    { provider: 'opencode', status: 'disconnected' },
  ],
}

function renderBanner(
  props: Partial<React.ComponentProps<typeof ProviderBanner>> = {},
  entry = '/p/cezar/',
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ProviderBanner status={DEFINITIVE_MISSING} pending={false} error={false} {...props} />
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('ProviderBanner', () => {
  it('renders nothing while provider status is pending', () => {
    const { container } = renderBanner({ pending: true })

    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the route itself failed', () => {
    const { container } = renderBanner({ error: true })

    expect(container.innerHTML).toBe('')
  })

  it('fails closed without rendering unexpected data when called with malformed rows', () => {
    const secret = 'unexpected-provider-payload'
    const { container } = renderBanner({
      status: {
        providers: [null, { provider: 'future', status: secret }],
      } as unknown as ProviderStatusResponse,
    })

    expect(container.innerHTML).toBe('')
    expect(screen.queryByText(secret)).toBeNull()
  })

  it('renders nothing when any provider is connected', () => {
    const { container } = renderBanner({
      status: {
        providers: DEFINITIVE_MISSING.providers.map((row) =>
          row.provider === 'claude' ? { provider: 'claude', status: 'connected' } : row,
        ),
      },
    })

    expect(container.innerHTML).toBe('')
  })

  it('says no provider is connected when every row is definitive and none is connected', () => {
    renderBanner()

    expect(screen.getByRole('status').textContent).toContain('No agent provider is connected.')
    expect(document.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe(
      'pending',
    )
  })

  it('says no provider could be verified when any row is unknown and none is connected', () => {
    renderBanner({
      status: {
        providers: DEFINITIVE_MISSING.providers.map((row) =>
          row.provider === 'claude' ? { provider: 'claude', status: 'unknown' } : row,
        ),
      },
    })

    expect(screen.getByRole('status').textContent).toContain(
      'No connected provider could be verified.',
    )
    expect(document.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe(
      'danger',
    )
  })

  it('links to the active project Settings → Agents providers anchor', () => {
    renderBanner()

    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/p/cezar/settings/agents#providers',
    )
  })

  it('is non-dismissible and keyboard-accessible', () => {
    renderBanner()

    const link = screen.getByRole('link', { name: 'Configure providers' })
    expect(screen.queryByRole('button')).toBeNull()
    link.focus()
    expect(document.activeElement).toBe(link)
  })
})
