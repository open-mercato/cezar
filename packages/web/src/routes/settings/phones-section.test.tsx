// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RELAY_TERMS, type PhonePairing, type PhonesResponse, type RelayAccountResponse, type RelayAccountStatus } from '@open-mercato/cezar-api-client'
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
  getRelayAccount: vi.fn(),
  setRelayAccount: vi.fn(),
  confirmRelayAccount: vi.fn(),
  resendRelayAccountCode: vi.fn(),
  deleteRelayAccount: vi.fn(),
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
    useRelayAccount: () => useQuery({ queryKey: actual.phoneKeys.account, queryFn: () => api.getRelayAccount() }),
  }
})

const base: PhonesResponse = {
  relayOrigin: 'https://relay.example.test', relay: { status: 'off' }, phones: [], pairing: null,
  account: { attached: true, email: 'me@example.test', termsVersion: RELAY_TERMS.version },
}
const NOW_S = Math.floor(Date.now() / 1000)
const confirmedStatus: RelayAccountStatus = {
  state: 'confirmed', email: 'me@example.test', termsVersion: RELAY_TERMS.version, acceptedAt: NOW_S, confirmedAt: NOW_S, graceEndsAt: null, secondsLeft: null,
}
const pendingStatus: RelayAccountStatus = { ...confirmedStatus, state: 'pending', confirmedAt: null, graceEndsAt: NOW_S + 47 * 3600 + 120, secondsLeft: 47 * 3600 + 120 }
const blockedStatus: RelayAccountStatus = { ...pendingStatus, state: 'blocked', graceEndsAt: NOW_S - 10, secondsLeft: 0 }
const confirmed: RelayAccountResponse = { local: base.account, status: confirmedStatus }
const fresh: RelayAccountResponse = { local: { attached: false }, status: null }
const QR = `cezar-pair:1.${'a'.repeat(43)}.${'b'.repeat(43)}.https://relay.example.test`
const started = { id: '11111111-1111-4111-8111-111111111111', qr: QR, relayOrigin: base.relayOrigin, expiresAt: new Date(Date.now() + 120_000).toISOString() }
const waiting: PhonePairing = { id: started.id, status: 'waiting', expiresAt: started.expiresAt }
const confirm: PhonePairing = { ...waiting, status: 'confirm', digits: '412751', method: 'qr', phone: { name: 'Pixel 9', platform: 'android' } }

const show = () => render(<QueryClientProvider client={createQueryClient()}><PhonesSection /></QueryClientProvider>)
const connect = async () => {
  const button = (await screen.findByRole('button', { name: 'Connect a phone' })) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  await screen.findByRole('img', { name: /QR code/ })
}

describe('PhonesSection', () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    api.getPhones.mockResolvedValue(base)
    api.getRelayAccount.mockResolvedValue(confirmed)
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

  it('marks a phone that has notifications on', async () => {
    api.getPhones.mockResolvedValue({
      ...base,
      phones: [{ deviceId: 'd'.repeat(22), label: 'Pixel 9', platform: 'android', addedAt: '', connected: true, push: true }],
    })
    show()
    await screen.findByText('Connected · Notifications on')
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
    const button = (await screen.findByRole('button', { name: 'Connect a phone' })) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    expect((await screen.findByRole('alert')).textContent).toContain('Too many codes')
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

describe('the relay account (RELAY_PROTOCOL.md § 18)', () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    api.getPhones.mockResolvedValue(base)
    api.startPhonePairing.mockResolvedValue(started)
    api.denyPhonePairing.mockResolvedValue({ ok: true })
    api.getRelayAccount.mockResolvedValue(confirmed)
  })
  afterEach(cleanup)

  const connectButton = async () => (await screen.findByRole('button', { name: 'Connect a phone' })) as HTMLButtonElement

  it('a new user gives an email and accepts the terms before any code', async () => {
    api.getPhones.mockResolvedValue({ ...base, account: { attached: false } })
    api.getRelayAccount.mockResolvedValue(fresh)
    api.setRelayAccount.mockResolvedValue({ local: base.account, status: pendingStatus, codeSent: true })
    show()
    await screen.findByTestId('relay-account-form')
    expect((await connectButton()).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe(RELAY_TERMS.termsUrl)
    expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe(RELAY_TERMS.privacyUrl)
    expect(screen.getByText(/privacy obligations/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.test' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(api.setRelayAccount).toHaveBeenCalledWith('me@example.test', RELAY_TERMS.version))
  })

  it('missing terms: the email alone cannot continue, and no code is shown', async () => {
    api.getPhones.mockResolvedValue({ ...base, account: { attached: false } })
    api.getRelayAccount.mockResolvedValue(fresh)
    show()
    await screen.findByTestId('relay-account-form')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.test' } })
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(await connectButton())
    expect(api.startPhonePairing).not.toHaveBeenCalled()
    expect(api.setRelayAccount).not.toHaveBeenCalled()
  })

  it('pending shows the time left and takes the emailed code', async () => {
    api.getRelayAccount.mockResolvedValue({ ...confirmed, status: pendingStatus })
    api.confirmRelayAccount.mockResolvedValue(confirmed)
    show()
    expect((await screen.findByTestId('relay-account-state')).textContent).toMatch(/waiting for confirmation\. Phones keep working for 4[67] h \d+ min/)
    expect((await connectButton()).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.confirmRelayAccount).toHaveBeenCalledWith('123456'))
  })

  it('confirmed shows the email and no code entry', async () => {
    show()
    expect((await screen.findByTestId('relay-account-state')).textContent).toMatch(/me@example\.test, confirmed/)
    expect(screen.queryByLabelText('Code from the email')).toBeNull()
    expect((await connectButton()).disabled).toBe(false)
  })

  it('blocked says why, resends, and confirming needs no new pairing', async () => {
    api.getRelayAccount.mockResolvedValue({ ...confirmed, status: blockedStatus })
    api.resendRelayAccountCode.mockResolvedValue({ expiresAt: NOW_S + 900 })
    show()
    expect((await screen.findByTestId('relay-account-state')).textContent).toMatch(/not confirmed within 48 hours.*No phone has to pair again/)
    fireEvent.click(screen.getByRole('button', { name: 'Resend code' }))
    await waitFor(() => expect(api.resendRelayAccountCode).toHaveBeenCalled())
  })

  it('change email reopens the form with the old address', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Change email' }))
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('me@example.test')
    expect(screen.getByRole('checkbox')).toBeTruthy()
  })

  it('a relay without accounts asks nothing', async () => {
    api.getPhones.mockResolvedValue({ ...base, account: { attached: false } })
    api.getRelayAccount.mockResolvedValue({ ...fresh, problem: 'unsupported' })
    show()
    const button = await connectButton()
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(screen.queryByTestId('relay-account-form')).toBeNull()
  })
})
