import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookForm, webhookDraft } from './webhook-form'

const urls = {
  Slack: 'https://hooks.slack.com/services/T1/B1/test',
  Discord: `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}`,
}
/** Radix Select in jsdom: open from the keyboard, pick with a click on the option. */
async function pick(label: string, option: string | RegExp) {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: option }))
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
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
  it.each(['Slack', 'Discord'] as const)('keeps %s Minimal preview free of titles and questions', async service => {
    mount()
    await pick('Destination', new RegExp(`${service} channel`))
    expect(screen.queryByLabelText('Synthetic JSON sample')).toBeNull()
    const preview = screen.getByLabelText(`${service} message sample`)
    expect(preview.textContent).not.toContain('Example generated task title')
    expect(preview.textContent).not.toContain('Which example option')
    await pick('Message content', /^Standard/)
    expect(preview.textContent).toContain('Example generated task title')
    expect(preview.textContent).toContain('Which example option')
    expect(screen.getByText(/Standard posts task titles/).textContent).toContain(service)
  })
  it('keeps custom receivers signed and previews their JSON', () => {
    mount()
    expect(screen.getByLabelText('Destination').getAttribute('data-value')).toBe('cezar.json.v1')
    expect(screen.getByLabelText('Synthetic JSON sample')).toBeTruthy()
    expect(screen.getByLabelText('Allow a receiver on this computer or private network')).toBeTruthy()
  })
  it('renders every receiver choice as the design-system select at the shared 36px height — no native select', () => {
    mount()
    for (const label of ['Destination', 'Events', 'Message content', 'Tasks', 'Waiting and review delay']) {
      const trigger = screen.getByLabelText(label)
      expect(trigger.tagName, label).toBe('BUTTON')
      expect(trigger.getAttribute('role'), label).toBe('combobox')
      expect(trigger.getAttribute('data-size'), label).toBe('default')
    }
    // Radix keeps a hidden native <select> for form association; a visible one is the retired control.
    expect(document.querySelector('select:not([aria-hidden="true"])')).toBeNull()
  })
})
