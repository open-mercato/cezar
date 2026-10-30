import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IssueFixListProvider, IssueFixListToolbar } from './issue-fix-actions'

const state = vi.hoisted(() => ({ providerError: false, runners: ['codex'] as string[] }))
vi.mock('@/api/queries', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/queries')>(),
  useSkills: () => ({ isPending: false, isError: false, data: [{ name: 'om-auto-fix-issue' }] }),
}))
vi.mock('@/components/engine-pills', () => ({
  engineRunBody: () => ({}),
  useResolvedEngine: () => ({ runner: 'codex', model: 'test-model', account: null, accounts: [],
    canRun: false, providerPending: false, ...state, accessMode: 'daybreak-blue',
    accessModeError: 'Choose an available model or Native default.' }),
}))
afterEach(() => { cleanup(); state.providerError = false; state.runners = ['codex'] })
function show() {
  render(<QueryClientProvider client={new QueryClient()}><IssueFixListProvider enabled items={[]} queued={new Map()}
    engine={{ runner: null, model: null, account: null }} onQueued={() => undefined}>
    <IssueFixListToolbar />
  </IssueFixListProvider></QueryClientProvider>)
}
describe('Issue fix engine guidance', () => {
  it('explains an incompatible remembered access mode and points to editable settings', () => {
    show()
    expect(screen.getByText('Choose an available model or Native default. Open an issue to adjust the agent settings.')).toBeTruthy()
    expect(screen.queryByText('Connect an agent to queue fixes.')).toBeNull()
  })
  it('keeps connection guidance when provider discovery fails', () => {
    state.providerError = true
    show()
    expect(screen.getByText('Connect an agent to queue fixes.')).toBeTruthy()
  })
})
