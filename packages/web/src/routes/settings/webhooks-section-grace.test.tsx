import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'

const mocks = vi.hoisted(() => ({ list: vi.fn(), telegramList: vi.fn() }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ isError: false, data: { capabilities: { webhooks: true } } }) }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => 'alpha' }))
vi.mock('@/api/client', async importOriginal => ({ ...(await importOriginal<typeof import('@/api/client')>()), getSelfUpdate: vi.fn().mockResolvedValue({ version: '0.15.0', installKind: 'checkout' }),
  webhookApi: { list: mocks.list }, telegramApi: { list: mocks.telegramList } }))
beforeEach(() => {
  vi.stubGlobal('EventSource', undefined); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
})
afterEach(() => { vi.unstubAllGlobals(); cleanup(); vi.clearAllMocks() })
const mount = () => render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><WebhooksSection /></MemoryRouter></QueryClientProvider>)

describe('Telegram is managed outside Webhooks', () => {
  it('does not query Telegram or expose its destination in Add receiver', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    expect(screen.queryByRole('option', { name: 'Telegram chat (bot)' })).toBeNull()
    expect(mocks.telegramList).not.toHaveBeenCalled()
  })
})
