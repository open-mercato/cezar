import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebhookReceiver } from '@open-mercato/cezar-api-client'
import { WebhookForm, webhookDraft } from './webhook-form'

const slack = 'https://hooks.slack.com/services/T1/B1/test'
afterEach(cleanup)
function mount({ receiver }: { receiver?: WebhookReceiver } = {}) {
  const save = vi.fn()
  function Form() {
    const [draft, setDraft] = useState(webhookDraft(receiver))
    return <WebhookForm receiver={receiver} draft={draft} setDraft={setDraft} pending={false} guideHref="https://example.com/guide" save={save} />
  }
  render(<Form />)
  return save
}
function slackReceiver(overrides: Partial<WebhookReceiver> = {}): WebhookReceiver {
  return { kind: 'live', id: 'r1', name: 'Team', destination: 'hooks.slack.com/…', format: 'slack.v1', state: 'active', revision: 3, deliveryRevision: 2,
    profile: 'standard', preset: 'attention', events: [], includeScheduledFailures: false, scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false,
    createdAt: '2026-10-31T12:00:00.000Z', updatedAt: '2026-10-31T12:00:00.000Z', pendingCount: 0, inFlightCount: 0,
    consecutiveFailures: 0, activationBlocked: false, lastTest: 'success', ...overrides }
}
function fillSlack() {
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'slack.v1' } })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team' } })
  fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: slack } })
}
const consent = /excerpt of the agent’s last message/

describe('agent message excerpt consent', () => {
  it('is offered only with Standard content, warns, and is sent only when ticked', () => {
    const save = mount()
    fillSlack()
    expect(screen.queryByLabelText(consent)).toBeNull()
    fireEvent.change(screen.getByLabelText('Message content'), { target: { value: 'standard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[0]![0]).not.toHaveProperty('includeAgentExcerpt')
    fireEvent.click(screen.getByLabelText(consent))
    expect(screen.getByRole('note').textContent).toMatch(/600 characters of what the agent wrote are sent to your Slack channel/)
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[1]![0]).toMatchObject({ includeAgentExcerpt: true, profile: 'standard' })
    fireEvent.change(screen.getByLabelText('Message content'), { target: { value: 'minimal' } })
    expect(screen.queryByLabelText(consent)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[2]![0]).not.toHaveProperty('includeAgentExcerpt')
  })
  it('restores a saved consent and clears it when unticked', () => {
    const save = mount({ receiver: slackReceiver({ includeAgentExcerpt: true }) })
    expect(screen.getByLabelText(consent)).toHaveProperty('checked', true)
    fireEvent.click(screen.getByLabelText(consent))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(save.mock.calls[0]![0]).not.toHaveProperty('includeAgentExcerpt')
  })
})
