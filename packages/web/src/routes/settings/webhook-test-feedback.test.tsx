import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhookTestFeedback } from './webhook-test-feedback'
const api = vi.hoisted(() => ({ deliveries: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function mount(state: string, status: string, reason?: string) {
 api.deliveries.mockResolvedValue({ items: [{ deliveryId: 'test1', status, reason }], receiver: { id: 'r', kind: 'live', state, deliveryRevision: 2, revision: 6, lastTest: 'none' } })
 const open = vi.fn()
 render(<QueryClientProvider client={createQueryClient()}><WebhookTestFeedback projectId="alpha" test={{ deliveryId: 'test1', receiverId: 'r', receiverName: 'Ops', initialState: 'suspended', deliveryRevision: 2 }} openHistory={open} /></QueryClientProvider>)
 return open
}
it('reports current Active state without attributing a competing Pause and Resume to the test', async () => {
 const open = mount('active', 'delivered')
 expect(await screen.findByText('Test delivered.')).toBeTruthy()
 expect(document.querySelector('[data-test-delivery="test1"]')).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: 'View in history' })); expect(open).toHaveBeenCalledWith('r')
})
it('does not claim recovery after receiver was paused', async () => {
 mount('paused', 'delivered')
 expect(await screen.findByText(/Test delivered\. Resume the receiver/)).toBeTruthy()
 expect(screen.queryByText(/recovered to Active/)).toBeNull()
})
it('names the local-network consent a policy-refused test needs, and that activation stays blocked', async () => {
 mount('inactive', 'failed', 'local_consent_required')
 expect(await screen.findByText(/Allow a receiver on this computer or private network/)).toBeTruthy()
 expect(screen.getByText(/Activation stays blocked until a test passes/)).toBeTruthy()
})
it('explains an uncertain test without prompting an automatic resend', async () => {
 mount('suspended', 'failed', 'outcome_unknown')
 expect(await screen.findByText(/Test result unknown/)).toBeTruthy()
 expect(screen.getByText(/Check your receiver before testing again/)).toBeTruthy()
})
