import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ExtensionFormView } from './form'
// The Radix Switch measures its thumb with a ResizeObserver, which jsdom lacks.
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('submits typed declared values, never prefills passwords, and displays save errors', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('Worker stopped'))
  render(<ExtensionFormView submit={submit} form={{ id: 'settings', title: 'Preferences', commandId: 'save', fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'limit', label: 'Limit', type: 'number', required: true },
    { key: 'active', label: 'Active', type: 'boolean', required: false },
    { key: 'token', label: 'Token', type: 'password', required: false },
  ], values: { name: 'Example', limit: 5, active: true, token: 'must-not-appear' } }} />)
  expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'new-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: 'Example', limit: 5, active: true, token: 'new-token' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Worker stopped')
  expect(alert.className).toContain('text-danger')
})

it('renders a boolean as a switch labelled inline, not a full-width text input', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<ExtensionFormView submit={submit} form={{ id: 'f', title: 'Flags', commandId: 'save', fields: [{ key: 'active', label: 'Active', type: 'boolean', required: false }], values: { active: false } }} />)
  const toggle = screen.getByRole('switch', { name: 'Active' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'Save Flags' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ active: true }))
})

it('omits empty optional number, select and password fields instead of sending 0, the first option or a blank secret', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<ExtensionFormView submit={submit} form={{ id: 'f', title: 'Optional', commandId: 'save', fields: [
    { key: 'limit', label: 'Limit', type: 'number', required: false },
    { key: 'mode', label: 'Mode', type: 'select', required: false, options: ['fast', 'slow'] },
    { key: 'token', label: 'Token', type: 'password', required: false },
  ] }} />)
  expect(screen.getByLabelText('Mode').getAttribute('data-value')).toBe('')
  expect(screen.getByText(/leave blank to keep/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save Optional' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({}))
})

it('keeps a saved select choice and a saved number', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<ExtensionFormView submit={submit} form={{ id: 'f', title: 'Saved', commandId: 'save', fields: [
    { key: 'limit', label: 'Limit', type: 'number', required: false },
    { key: 'mode', label: 'Mode', type: 'select', required: false, options: ['fast', 'slow'] },
  ], values: { limit: 0, mode: 'slow' } }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save Saved' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ limit: 0, mode: 'slow' }))
})

const refreshedForm = { id: 'refresh', title: 'Refresh', commandId: 'save', fields: [
  { key: 'name', label: 'Name', type: 'text' as const, required: false },
  { key: 'active', label: 'Active', type: 'boolean' as const, required: false },
  { key: 'mode', label: 'Mode', type: 'select' as const, required: false, options: ['fast', 'slow'] },
  { key: 'limit', label: 'Limit', type: 'number' as const, required: false },
  { key: 'token', label: 'Token', type: 'password' as const, required: false },
], values: { name: 'old', active: false, mode: 'fast', limit: 1 } }
const freshForm = { ...refreshedForm, values: { name: 'fresh', active: true, mode: 'slow', limit: 2 } }
it('refreshes every clean field and submits authoritative values', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  const view = render(<ExtensionFormView form={refreshedForm} submit={submit} />)
  view.rerender(<ExtensionFormView form={freshForm} submit={submit} />)
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'fresh')
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(screen.getByLabelText('Mode').getAttribute('data-value')).toBe('slow')
  expect(screen.getByLabelText('Limit')).toHaveProperty('value', '2')
  fireEvent.click(screen.getByRole('button', { name: 'Save Refresh' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith(freshForm.values))
})
it('preserves a dirty draft and offers an explicit reload on refresh', () => {
  const submit = vi.fn()
  const view = render(<ExtensionFormView form={refreshedForm} submit={submit} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'draft' } })
  view.rerender(<ExtensionFormView form={freshForm} submit={submit} />)
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'draft')
  expect(screen.getByRole('alert').textContent).toMatch(/changed.*draft/i)
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved values' }))
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'fresh')
})
it('applies canonical values and clears passwords after an async save', async () => {
  let finish!: (form: typeof freshForm) => void
  const submit = vi.fn(() => new Promise<typeof freshForm>(resolve => { finish = resolve }))
  render(<ExtensionFormView form={refreshedForm} submit={submit} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  fresh  ' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Refresh' }))
  expect(screen.getByLabelText('Name')).toHaveProperty('disabled', true)
  finish(freshForm)
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveProperty('value', 'fresh'))
  expect(screen.getByLabelText('Token')).toHaveProperty('value', '')
  fireEvent.click(screen.getByRole('button', { name: 'Save Refresh' }))
  expect(submit).toHaveBeenLastCalledWith(freshForm.values)
  finish(freshForm)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save Refresh' })).toHaveProperty('disabled', false))
})
it('retains draft and password after failure and reconciles a refresh during a successful retry', async () => {
  let finish!: () => void
  const submit = vi.fn().mockRejectedValueOnce(new Error('Save failed')).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const view = render(<ExtensionFormView form={refreshedForm} submit={submit} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'draft' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Refresh' }))
  await screen.findByText('Save failed')
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'draft')
  expect(screen.getByLabelText('Token')).toHaveProperty('value', 'secret')
  fireEvent.click(screen.getByRole('button', { name: 'Save Refresh' }))
  view.rerender(<ExtensionFormView form={freshForm} submit={submit} />)
  finish()
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveProperty('value', 'fresh'))
  expect(screen.getByLabelText('Token')).toHaveProperty('value', '')
})
it('clears a saved password so an unrelated second save cannot resend it', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<ExtensionFormView form={refreshedForm} submit={submit} />)
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Refresh' }))
  await waitFor(() => expect(screen.getByLabelText('Token')).toHaveProperty('value', ''))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'edited' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Refresh' }))
  await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ ...refreshedForm.values, name: 'edited' }))
})
