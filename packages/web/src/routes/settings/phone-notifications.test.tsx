import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_PHONE_PUSH_PREFS, type PhonePushPrefs } from '@open-mercato/cezar-api-client'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PhoneNotificationsForm } from './phone-notifications'

/** Spec 2026-11-20-phone-notifications-inbox: which kinds push, which count on the icon, quiet hours. */
function Harness({ onChange }: { onChange: (next: PhonePushPrefs) => void }) {
  const [value, setValue] = useState(DEFAULT_PHONE_PUSH_PREFS)
  return <PhoneNotificationsForm idPrefix="t" timeZone="Europe/Warsaw" value={value} onChange={(next) => { setValue(next); onChange(next) }} />
}

afterEach(cleanup)

describe('PhoneNotificationsForm', () => {
  it('starts from the defaults: everything pushes, failed tasks do not count on the icon', () => {
    render(<Harness onChange={vi.fn()} />)
    const checked = (slot: string) => [...document.querySelectorAll(`[data-slot="${slot}"]`)]
      .filter((control) => control.getAttribute('aria-checked') === 'true').map((control) => control.getAttribute('data-kind'))
    expect(checked('phone-push-kind')).toEqual(['question', 'approval', 'task', 'review', 'failed', 'message'])
    expect(checked('phone-badge-kind')).toEqual(['question', 'approval', 'task', 'review', 'message'])
  })

  it('turns a kind off in the list it belongs to, keeping the order', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(document.querySelector('[data-slot="phone-push-kind"][data-kind="approval"]')!)
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PHONE_PUSH_PREFS, push: ['question', 'task', 'review', 'failed', 'message'] })
    fireEvent.click(document.querySelector('[data-slot="phone-badge-kind"][data-kind="failed"]')!)
    expect(onChange.mock.lastCall?.[0].icon).toEqual(['question', 'approval', 'task', 'review', 'failed', 'message'])
  })

  it('sets quiet hours from 22:00 to 07:00 in the phone’s zone, edits either end, and removes them', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(document.querySelector('[data-slot="phone-quiet-hours"]')!)
    expect(onChange.mock.lastCall?.[0].quiet).toEqual({ from: '22:00', to: '07:00', timeZone: 'Europe/Warsaw' })
    fireEvent.change(screen.getByLabelText('Quiet until'), { target: { value: '06:30' } })
    expect(onChange.mock.lastCall?.[0].quiet).toEqual({ from: '22:00', to: '06:30', timeZone: 'Europe/Warsaw' })
    fireEvent.click(document.querySelector('[data-slot="phone-quiet-hours"]')!)
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty('quiet')
    // What the app understands is never the form's to change.
    expect(onChange.mock.lastCall?.[0].understands).toEqual(['attention'])
  })
})

describe('usePhoneNotificationsEditor', () => {
  it('keeps the newest choice when an older save answers last', async () => {
    const { renderHook, act, waitFor } = await import('@testing-library/react')
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
    const { usePhoneNotificationsEditor } = await import('./phone-notifications')
    const answers: Array<(value: PhonePushPrefs) => void> = []
    const save = (next: PhonePushPrefs) => new Promise<PhonePushPrefs>((resolve) => { answers.push(() => resolve(next)) })
    const client = new QueryClient()
    const { result } = renderHook(() => usePhoneNotificationsEditor(DEFAULT_PHONE_PUSH_PREFS, save), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
    const first = { ...DEFAULT_PHONE_PUSH_PREFS, push: [] }
    const second = { ...DEFAULT_PHONE_PUSH_PREFS, push: ['question' as const] }
    act(() => result.current.change(first))
    act(() => result.current.change(second))
    await waitFor(() => expect(answers).toHaveLength(2))
    await act(async () => { answers[1]!(second); answers[0]!(first) })
    await waitFor(() => expect(result.current.value).toEqual(second))
  })
})
