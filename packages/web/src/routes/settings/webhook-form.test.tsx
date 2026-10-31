import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebhookForm, webhookDraft } from './webhook-form'

const urls = {
  Slack: 'https://hooks.slack.com/services/T1/B1/test',
  Discord: `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}`,
}
afterEach(cleanup)
function mount() {
  const save = vi.fn()
  function Form() {
    const [draft, setDraft] = useState(webhookDraft())
    return <WebhookForm draft={draft} setDraft={setDraft} pending={false} guideHref="https://example.com/guide" save={save} />
  }
  render(<Form />)
  return save
}
describe('chat destination settings', () => {
  it.each(['Slack', 'Discord'] as const)('switches a pasted %s URL and submits without private-network consent', service => {
    const save = mount()
    fireEvent.click(screen.getByLabelText('Allow a receiver on this computer or private network'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team alerts' } })
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: urls[service] } })
    expect(screen.getByRole('status').textContent).not.toContain(urls[service])
    fireEvent.click(screen.getByRole('button', { name: `Use ${service}` }))
    expect(screen.queryByLabelText('Allow a receiver on this computer or private network')).toBeNull()
    expect(screen.getByText(/receivers need no signing key/)).toBeTruthy()
    expect(screen.getByRole('link', { name: `${service} setup guide` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ format: `${service.toLowerCase()}.v1`, allowLocalNetwork: false, url: urls[service] }))
  })
  it.each(['Slack', 'Discord'] as const)('keeps %s Minimal preview free of titles and questions', service => {
    mount()
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: `${service.toLowerCase()}.v1` } })
    expect(screen.queryByLabelText('Synthetic JSON sample')).toBeNull()
    const preview = screen.getByLabelText(`${service} message sample`)
    expect(preview.textContent).not.toContain('Example generated task title')
    expect(preview.textContent).not.toContain('Which example option')
    fireEvent.change(screen.getByLabelText('Message content'), { target: { value: 'standard' } })
    expect(preview.textContent).toContain('Example generated task title')
    expect(preview.textContent).toContain('Which example option')
    expect(screen.getByText(/Standard posts task titles/).textContent).toContain(service)
  })
  it('keeps custom receivers signed and previews their JSON', () => {
    mount()
    expect(screen.getByLabelText('Destination')).toHaveProperty('value', 'cezar.json.v1')
    expect(screen.getByLabelText('Synthetic JSON sample')).toBeTruthy()
    expect(screen.getByLabelText('Allow a receiver on this computer or private network')).toBeTruthy()
  })
  it('uses the shared 36px control height for every receiver select', () => {
    mount()
    for (const label of ['Destination', 'Events', 'Message content', 'Tasks', 'Waiting and review delay']) {
      expect(screen.getByLabelText(label).classList.contains('h-9'), label).toBe(true)
    }
  })
})
