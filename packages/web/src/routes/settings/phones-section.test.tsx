// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PhonePairing, PhonesResponse } from '@open-mercato/cezar-api-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { PhonesSection } from './phones-section'
import { visibleSettingsSections } from './registry'

const api = vi.hoisted(() => ({
  getPhones: vi.fn(),
  startPhonePairing: vi.fn(),
  revealPhoneCode: vi.fn(),
  approvePhonePairing: vi.fn(),
  denyPhonePairing: vi.fn(),
  renamePhone: vi.fn(),
  removePhone: vi.fn(),
  setRelayAddress: vi.fn(),
  testRelayAddress: vi.fn(),
}))
let emit: ((name: string) => void) | undefined

vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: (name: string) => void) => { emit = listener; return () => { emit = undefined } },
}))
vi.mock('@/api/phones', async (original) => {
  const actual = await original<typeof import('@/api/phones')>()
  const { useQuery, useQueryClient } = await import('@tanstack/react-query')
  const { useEffect } = await import('react')
  return {
    ...actual,
    ...api,
    usePhones: () => {
      const queryClient = useQueryClient()
      useEffect(() => { emit = () => void queryClient.invalidateQueries({ queryKey: actual.phoneKeys.list }) }, [queryClient])
      return useQuery({ queryKey: actual.phoneKeys.list, queryFn: () => api.getPhones() })
    },
  }
})

const base: PhonesResponse = { relayOrigin: 'https://relay.example.test', relaySource: 'settings', relay: { status: 'off' }, phones: [], pairing: null }
const unset: PhonesResponse = { ...base, relayOrigin: '', relaySource: 'none' }
const paired: PhonesResponse = { ...base, phones: [{ deviceId: 'd'.repeat(22), label: 'Pixel 9', platform: 'android', addedAt: '', connected: true }] }
const NEXT = 'https://own.example.test'
const QR = `https://relay.example.test/p#1.${'a'.repeat(43)}.${'b'.repeat(43)}`
const started = { id: '11111111-1111-4111-8111-111111111111', qr: QR, relayOrigin: base.relayOrigin, expiresAt: new Date(Date.now() + 120_000).toISOString() }
const waiting: PhonePairing = { id: started.id, status: 'waiting', expiresAt: started.expiresAt }
const confirm: PhonePairing = { ...waiting, status: 'confirm', digits: '412751', method: 'qr', phone: { name: 'Pixel 9', platform: 'android' } }

const show = () => render(<QueryClientProvider client={createQueryClient()}><PhonesSection /></QueryClientProvider>)
const connect = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
  await screen.findByRole('img', { name: /QR code/ })
}

describe('PhonesSection', () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    api.getPhones.mockResolvedValue(base)
    api.startPhonePairing.mockResolvedValue(started)
    api.denyPhonePairing.mockResolvedValue({ ok: true })
    api.approvePhonePairing.mockResolvedValue({ ok: true })
    api.removePhone.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('connects nothing until the click', async () => {
    show()
    await screen.findByRole('button', { name: 'Connect a phone' })
    expect(api.startPhonePairing).not.toHaveBeenCalled()
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull()
  })

  it('shows the QR code, a countdown, and the code only on request, with the relay address', async () => {
    show()
    await connect()
    expect(screen.getByText(/Expires in [12]:/)).toBeTruthy()
    expect(api.revealPhoneCode).not.toHaveBeenCalled()
    api.revealPhoneCode.mockResolvedValue({ code: 'QRFX-7KMD-2NVB', relayOrigin: base.relayOrigin })
    fireEvent.click(screen.getByRole('button', { name: 'Type a code instead' }))
    await screen.findByText('QRFX-7KMD-2NVB')
    expect(screen.getByText(base.relayOrigin)).toBeTruthy()
  })

  it('says to scan inside the app', async () => {
    show()
    await connect()
    expect(screen.getByText(/inside the Cezar app, not with your camera app/)).toBeTruthy()
  })

  it('blocks on a dialog with the digits and a plain statement, and approves', async () => {
    api.getPhones.mockResolvedValue({ ...base, pairing: confirm })
    show()
    expect((await screen.findByTestId('phone-digits')).textContent).toBe('412751')
    expect(screen.getByText(/can run tasks on this computer/)).toBeTruthy()
    expect(screen.getByText(/Pixel 9 \(android\), as reported by the phone/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.approvePhonePairing).toHaveBeenCalledWith(confirm.id))
  })

  it('denies', async () => {
    api.getPhones.mockResolvedValue({ ...base, pairing: confirm })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(api.denyPhonePairing).toHaveBeenCalledWith(confirm.id))
  })

  it('offers Show a new code after a failure, naming it', async () => {
    show()
    await connect()
    api.getPhones.mockResolvedValue({ ...base, pairing: { ...waiting, status: 'failed', failure: 'contested' } })
    emit?.('phone-pairing')
    await screen.findByText(/A second phone tried/)
    expect(screen.getByRole('button', { name: 'Show a new code' })).toBeTruthy()
  })

  it('a closed screen discards the pending pairing', async () => {
    api.getPhones.mockResolvedValue({ ...base, pairing: waiting })
    const view = show()
    await connect()
    view.unmount()
    expect(api.denyPhonePairing).toHaveBeenCalledWith(started.id)
  })

  it('lists phones with status and removes after confirming', async () => {
    api.getPhones.mockResolvedValue({
      ...base,
      relay: { status: 'connected' },
      phones: [{ deviceId: 'd'.repeat(22), label: 'Pixel 9', platform: 'android', addedAt: '', connected: true }],
    })
    show()
    await screen.findByText('Connected')
    expect(screen.getByText('Relay: connected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pixel 9' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.removePhone).toHaveBeenCalledWith('d'.repeat(22)))
  })

  it('shows a start refusal', async () => {
    api.startPhonePairing.mockRejectedValue(new Error('Too many codes this hour. Try again later.'))
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Too many codes')
  })
})

describe('the relay address', () => {
  const field = () => screen.findByLabelText('Relay address') as Promise<HTMLInputElement>
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
  const type = async (value: string) => fireEvent.change(await field(), { target: { value } })
  const passTest = async () => {
    api.testRelayAddress.mockResolvedValue({ ok: true, origin: NEXT, protocol: 1 })
    await type(NEXT)
    fireEvent.click(button('Test'))
    await screen.findByText(/speaks a compatible protocol version/)
  }

  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    api.getPhones.mockResolvedValue(base)
    api.setRelayAddress.mockResolvedValue({ ...base, relayOrigin: NEXT })
  })
  afterEach(cleanup)

  it('with no address says one is needed, disables Connect a phone and contacts nothing', async () => {
    api.getPhones.mockResolvedValue(unset)
    show()
    await screen.findByText(/needs a relay address/)
    expect(button('Connect a phone').disabled).toBe(true)
    expect(button('Test').disabled).toBe(true)
    expect(api.testRelayAddress).not.toHaveBeenCalled()
    expect(api.startPhonePairing).not.toHaveBeenCalled()
    expect(api.setRelayAddress).not.toHaveBeenCalled()
  })

  it('Save stays off until Test passes for exactly this value', async () => {
    show()
    await type(NEXT)
    expect(button('Save').disabled).toBe(true)
    await passTest()
    expect(button('Save').disabled).toBe(false)
    await type(`${NEXT}:8443`)
    expect(button('Save').disabled).toBe(true)
  })

  it('shows a clear failure and keeps Save off', async () => {
    api.testRelayAddress.mockResolvedValue({ ok: false, reason: 'incompatible' })
    show()
    await type(NEXT)
    fireEvent.click(button('Test'))
    expect((await screen.findByRole('alert')).textContent).toContain('protocol version')
    expect(button('Save').disabled).toBe(true)
  })

  it('locks the field during Test, so the result belongs to the value tested', async () => {
    let finish: (result: unknown) => void = () => {}
    api.testRelayAddress.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    show()
    await type(NEXT)
    fireEvent.click(button('Test'))
    await waitFor(async () => expect((await field()).readOnly).toBe(true))
    finish({ ok: true, origin: NEXT, protocol: 1 })
    await screen.findByText(/speaks a compatible protocol version/)
    expect((await field()).readOnly).toBe(false)
  })

  it('saves with no warning when no phone is paired', async () => {
    show()
    await passTest()
    fireEvent.click(button('Save'))
    await waitFor(() => expect(api.setRelayAddress).toHaveBeenCalledWith(NEXT, false))
  })

  it('warns before a change with phones paired, and Cancel sends nothing', async () => {
    api.getPhones.mockResolvedValue(paired)
    show()
    await passTest()
    fireEvent.click(button('Save'))
    await screen.findByText(/disconnects now/)
    expect(screen.getByText(/pair it again/)).toBeTruthy()
    fireEvent.click(button('Cancel'))
    expect(api.setRelayAddress).not.toHaveBeenCalled()
    fireEvent.click(button('Save'))
    fireEvent.click(await screen.findByRole('button', { name: 'Change and disconnect' }))
    await waitFor(() => expect(api.setRelayAddress).toHaveBeenCalledWith(NEXT, true))
  })

  it('clearing warns the same way', async () => {
    api.getPhones.mockResolvedValue(paired)
    show()
    await field()
    fireEvent.click(button('Clear'))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear and disconnect' }))
    await waitFor(() => expect(api.setRelayAddress).toHaveBeenCalledWith(null, true))
  })

  it('CEZ_RELAY_URL shows read-only with an explanation, still testable', async () => {
    api.getPhones.mockResolvedValue({ ...base, relaySource: 'env' })
    show()
    expect((await field()).readOnly).toBe(true)
    expect(screen.getByText(/Unset it and restart cezar/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(button('Test').disabled).toBe(false)
  })

  it('an invalid CEZ_RELAY_URL says so and leaves Connect a phone disabled', async () => {
    api.getPhones.mockResolvedValue({ ...unset, relaySource: 'env-invalid' })
    show()
    expect((await screen.findByRole('alert')).textContent).toContain('not a valid relay address')
    expect((await field()).readOnly).toBe(true)
    expect(button('Connect a phone').disabled).toBe(true)
    expect(screen.queryByText(/add one below/)).toBeNull()
  })

  it('states what the relay sees and where to scan, with or without an address', async () => {
    api.getPhones.mockResolvedValue(unset)
    show()
    await screen.findByText(/end-to-end encrypted/)
    expect(screen.getByText(/see IP addresses and the timing/)).toBeTruthy()
    expect(screen.getByText(/Scan only inside the Cezar app/)).toBeTruthy()
  })
})

describe('the section follows capabilities.phonePairing', () => {
  const ids = (phonePairing?: boolean) => visibleSettingsSections('global', phonePairing === undefined ? undefined : { phonePairing }).map((section) => section.id)

  it('is hidden off, absent or unknown, and listed on', () => {
    expect(ids(false)).not.toContain('phones')
    expect(ids()).not.toContain('phones')
    expect(ids(true)).toContain('phones')
  })
})
