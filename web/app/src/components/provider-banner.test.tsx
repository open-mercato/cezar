import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProviderStatusResponse } from '@/api/types'
import { ProviderBanner } from './provider-banner'

const DEFINITIVE_MISSING: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true },
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
}

function renderBanner(
  props: Partial<React.ComponentProps<typeof ProviderBanner>> = {},
  entry = '/p/cezar/',
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ProviderBanner
        status={DEFINITIVE_MISSING}
        pending={false}
        error={false}
        dismissals={{}}
        onDismissAuthFailures={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('ProviderBanner', () => {
  it('renders nothing while provider status is pending', () => {
    const { container } = renderBanner({ pending: true })

    expect(container.innerHTML).toBe('')
  })

  it('keeps the generic provider banner hidden when a refetch fails with cached generic status', () => {
    const { container } = renderBanner({ error: true })

    expect(container.innerHTML).toBe('')
  })

  it('keeps a cached runtime incident visible when a background refetch fails', () => {
    renderBanner({
      status: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
      error: true,
    })

    expect(screen.getByRole('alert').textContent).toContain(
      'Provider authentication failed during a task: Claude Code.',
    )
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

  it('renders nothing when any provider is enabled and connected', () => {
    const { container } = renderBanner({
      status: {
        providers: DEFINITIVE_MISSING.providers.map((row) =>
          row.provider === 'claude' ? { provider: 'claude', status: 'connected', enabled: true } : row,
        ),
      },
    })

    expect(container.innerHTML).toBe('')
  })

  it('shows the disabled message when credentials exist but every provider is disabled', () => {
    renderBanner({
      status: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'disconnected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    expect(screen.getByRole('status').textContent).toContain('No agent provider is enabled.')
  })

  it('shows every runtime incident even while another provider is connected', () => {
    const onDismiss = vi.fn()
    renderBanner({
      status: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
        ],
      },
      onDismissAuthFailures: onDismiss,
    })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(
      'Provider authentication failed during a task: Claude Code, OpenCode.',
    )
    fireEvent.click(screen.getByRole('button', {
      name: 'Dismiss provider authentication alert',
    }))
    expect(onDismiss).toHaveBeenCalledWith([
      { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-1' },
      { provider: 'opencode', label: 'OpenCode', authFailureId: 'open-1' },
    ])
  })

  it('hides a matching dismissed incident while a newer incident resurfaces', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }
    const hidden = renderBanner({ status, dismissals: { claude: 'claude-1' } })

    expect(screen.queryByRole('alert')).toBeNull()

    hidden.unmount()
    renderBanner({
      status: {
        providers: status.providers.map((row) =>
          row.provider === 'claude' ? { ...row, authFailureId: 'claude-2' } : row,
        ),
      },
      dismissals: { claude: 'claude-1' },
    })

    expect(screen.getByRole('alert').textContent).toContain('Claude Code')
  })

  it('keeps the runtime alert settings link scoped to the active project', () => {
    renderBanner({
      status: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    expect(screen.getByRole('link', { name: 'Open agent settings' }).getAttribute('href')).toBe(
      '/p/cezar/settings/agents#providers',
    )
  })

  it('reveals the generic safety banner after the runtime incident is dismissed', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
        { provider: 'codex', status: 'not-installed', enabled: true },
        { provider: 'opencode', status: 'disconnected', enabled: true },
      ],
    }
    const view = renderBanner({ status })

    fireEvent.click(screen.getByRole('button', {
      name: 'Dismiss provider authentication alert',
    }))
    view.rerender(
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <ProviderBanner
          status={status}
          pending={false}
          error={false}
          dismissals={{ claude: 'claude-1' }}
          onDismissAuthFailures={vi.fn()}
        />
      </MemoryRouter>,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('No agent provider credentials were found.')
  })

  it('says no provider credentials were found when every row is definitive and none is connected', () => {
    renderBanner()

    expect(screen.getByRole('status').textContent).toContain('No agent provider credentials were found.')
    expect(document.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe(
      'pending',
    )
  })

  it('says no provider could be verified when any row is unknown and none is connected', () => {
    renderBanner({
      status: {
        providers: DEFINITIVE_MISSING.providers.map((row) =>
          row.provider === 'claude' ? { provider: 'claude', status: 'unknown', enabled: true } : row,
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
