import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const list = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ webhookApi: { list } }))
const { isOwnWebhookNotice, withOwnWebhookChange } = await import('./own-webhook-changes')
const notice = (changeSequence: number, receiverId = 'r1', source: 'cockpit/api' | 'system' = 'cockpit/api') => ({ changeSequence, at: '2026-11-17T00:00:00Z', action: 'activated', receiverId, source })

describe('own webhook changes', () => {
  it('hides the notice this tab opened, and keeps later and foreign changes', async () => {
    const client = new QueryClient()
    client.setQueryData(['p1', 'webhooks'], { changeSequence: 4 })
    list.mockResolvedValue({ changeSequence: 5, notice: notice(5, 'setup-receiver') })
    let hiddenWhileRunning = false
    await withOwnWebhookChange(client, 'p1', ['setup-receiver'], async () => { hiddenWhileRunning = isOwnWebhookNotice('p1', notice(5, 'setup-receiver')); return {} })
    expect(hiddenWhileRunning).toBe(true)
    await vi.waitFor(() => expect(list).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve))
    expect(isOwnWebhookNotice('p1', notice(5, 'setup-receiver'))).toBe(true)
    // Another tab, the API or another process changes something next.
    expect(isOwnWebhookNotice('p1', notice(6, 'setup-receiver'))).toBe(false)
    expect(isOwnWebhookNotice('p1', notice(5, 'setup-receiver', 'system'))).toBe(false)
    expect(isOwnWebhookNotice('p2', notice(5, 'setup-receiver'))).toBe(false)
  })
  it('does not claim a foreign notice that landed while the activation ran', async () => {
    const client = new QueryClient()
    client.setQueryData(['p3', 'webhooks'], { changeSequence: 1 })
    list.mockResolvedValue({ changeSequence: 3, notice: notice(3, 'someone-else') })
    await withOwnWebhookChange(client, 'p3', ['mine'], async () => ({ receiverId: 'mine' }), result => [result.receiverId])
    await new Promise(resolve => setTimeout(resolve))
    expect(isOwnWebhookNotice('p3', notice(3, 'someone-else'))).toBe(false)
  })
})
