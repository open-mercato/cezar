import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_PHONE_NOTIFICATION_PREFS, type PhoneNotificationPrefs } from '@open-mercato/cezar-api-client'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PhoneNotificationsForm } from './phone-notifications'

/** Spec 2026-11-20-phone-notifications-inbox: which kinds push, which count on the icon, quiet hours. */
function Harness({ onChange }: { onChange: (next: PhoneNotificationPrefs) => void }) {
  const [value, setValue] = useState(DEFAULT_PHONE_NOTIFICATION_PREFS)
  return <PhoneNotificationsForm idPrefix="t" value={value} onChange={(next) => { setValue(next); onChange(next) }} />
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
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PHONE_NOTIFICATION_PREFS, push: ['question', 'task', 'review', 'failed', 'message'] })
    fireEvent.click(document.querySelector('[data-slot="phone-badge-kind"][data-kind="failed"]')!)
    expect(onChange.mock.lastCall?.[0].badge).toEqual(['question', 'approval', 'task', 'review', 'failed', 'message'])
  })

  it('sets quiet hours from 22:00 to 07:00, then edits either end', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(document.querySelector('[data-slot="phone-quiet-hours"]')!)
    expect(onChange.mock.lastCall?.[0].quietHours).toEqual({ start: '22:00', end: '07:00' })
    fireEvent.change(screen.getByLabelText('Quiet until'), { target: { value: '06:30' } })
    expect(onChange.mock.lastCall?.[0].quietHours).toEqual({ start: '22:00', end: '06:30' })
  })
})
