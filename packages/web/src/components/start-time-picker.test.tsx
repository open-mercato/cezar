import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CreateRunInput, DeferredPreview } from '@open-mercato/cezar-api-client'
import { getDeferredStartOptions, previewDeferredStart } from '@/api/client'
import { startLabel, AUTO_PREVIEW_MS, StartTimePicker, type StartChoice } from './start-time-picker'
vi.mock('@/api/client', () => ({ getDeferredStartOptions: vi.fn(), previewDeferredStart: vi.fn() }))
beforeEach(() => { vi.mocked(getDeferredStartOptions).mockResolvedValue({ timeZone: 'Europe/Warsaw', usageReset: { available: true, provider: 'claude' } }) })
afterEach(() => { cleanup(); vi.resetAllMocks() })
const task: CreateRunInput = { task: 'Later', workflow: 'quick-task', runner: 'claude' }
function Harness({ text = 'Later', disabledReason }: { text?: string; disabledReason?: string }) {
  const [value, onChange] = useState<StartChoice | null>(null)
  return <StartTimePicker task={{ ...task, task: text }} value={value} onChange={onChange} disabledReason={disabledReason} />
}
const preview = { available: true as const, notBefore: '2099-01-01T09:00:00Z', timeZone: 'UTC', previewRevision: 'r', observation: 'Weekly, observed yesterday' }
it('requires a preview, shows the server zone and returns focus on Escape', async () => {
  vi.mocked(previewDeferredStart).mockResolvedValue(preview)
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Choose task start time' })
  fireEvent.click(trigger)
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  await screen.findByText('Weekly, observed yesterday')
  expect(screen.getByText(/Earliest start:/).textContent).toContain('UTC')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})
it('ignores an old in-flight preview when the task changes and requires a new check', async () => {
  let finish!: (value: DeferredPreview) => void
  vi.mocked(previewDeferredStart).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  view.rerender(<Harness text="Different account or task" />)
  await act(async () => { finish(preview) })
  expect(screen.queryByText(/Earliest start:/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Check start time' })).toBeTruthy()
})
it('explains disabled scheduling and exposes unavailable metadata without changing to Now', async () => {
  const view = render(<Harness disabledReason="Remove attachments to schedule this task." />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  expect((screen.getByLabelText('Pick date & time') as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText(/Remove attachments/)).toBeTruthy()
  view.rerender(<Harness />)
  vi.mocked(previewDeferredStart).mockResolvedValue({ available: false, reason: 'no-data', message: 'No observed reset.' })
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  expect((await screen.findByRole('alert')).textContent).toBe('No observed reset.')
  expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).checked).toBe(true)
})

it.each(['unavailable', 'error'])('clears a successful preview immediately on refresh and after %s', async outcome => {
  vi.mocked(previewDeferredStart).mockResolvedValueOnce(preview)
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  await screen.findByText(/Earliest start:/)
  let finish!: () => void
  vi.mocked(previewDeferredStart).mockReturnValueOnce(new Promise((resolve, reject) => {
    finish = () => outcome === 'error' ? reject(new Error('Preview failed')) : resolve({ available: false, reason: 'no-data', message: 'Preview failed' })
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }))
  expect(screen.queryByText(/Earliest start:/)).toBeNull()
  await act(async () => finish())
  expect((await screen.findByRole('alert')).textContent).toBe('Preview failed')
  expect(screen.queryByText(/Earliest start:/)).toBeNull()
  const radio = screen.getByLabelText('After usage limit resets')
  expect(radio.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
})

it('does not revive a checked preview after task settings change and change back', async () => {
  vi.mocked(previewDeferredStart).mockResolvedValue(preview)
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  await screen.findByText(/Earliest start:/)
  view.rerender(<Harness text="Changed" />)
  view.rerender(<Harness />)
  expect(screen.queryByText(/Earliest start:/)).toBeNull()
})

it('names a native radio group uniquely per picker and associates date/time errors', async () => {
  vi.mocked(previewDeferredStart).mockResolvedValue({ available: false, reason: 'window-over', message: 'Choose a future time' })
  const first = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  expect(screen.getByRole('group', { name: 'Start task' })).toBeTruthy()
  const radios = screen.getAllByRole('radio') as HTMLInputElement[]
  const name = radios[0]!.name
  expect(name).not.toBe('')
  expect(radios.every(radio => radio.name === name)).toBe(true)
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
  const error = await screen.findByRole('alert')
  for (const label of ['Date', 'Time (server time zone)']) {
    expect(screen.getByLabelText(label).getAttribute('aria-describedby')).toBe(error.id)
    expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true')
  }
  first.unmount()
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  expect((screen.getAllByRole('radio')[0] as HTMLInputElement).name).not.toBe(name)
})

it('rejects a stale completion after switching start choices while a newer check is pending', async () => {
  let first!: (value: DeferredPreview) => void
  let second!: (value: DeferredPreview) => void
  vi.mocked(previewDeferredStart)
    .mockReturnValueOnce(new Promise(resolve => { first = resolve }))
    .mockReturnValueOnce(new Promise(resolve => { second = resolve }))
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
  await waitFor(() => expect(previewDeferredStart).toHaveBeenCalledTimes(2))
  await act(async () => first(preview))
  expect(screen.queryByText(/Earliest start:/)).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('Checking the start time…')
  await act(async () => second({ ...preview, observation: 'Current check' }))
  await screen.findByText('Current check')
  expect((screen.getByLabelText('Pick date & time') as HTMLInputElement).checked).toBe(true)
})

it('invalidates readiness when scheduling becomes unavailable, even after it returns', async () => {
  vi.mocked(previewDeferredStart).mockResolvedValue(preview)
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  await screen.findByText(/Earliest start:/)
  view.rerender(<Harness disabledReason="Scheduling disabled" />)
  view.rerender(<Harness />)
  expect(screen.queryByText(/Earliest start:/)).toBeNull()
})

function Reporting({ text = 'Later', disabledReason }: { text?: string; disabledReason?: string }) {
  const [value, onChange] = useState<StartChoice | null>(null)
  const [blocked, setBlocked] = useState<string>()
  return <><StartTimePicker task={{ ...task, task: text }} value={value} onChange={onChange} disabledReason={disabledReason} onBlockedChange={setBlocked} /><output data-testid="blocked">{blocked ?? ''}</output></>
}
const trigger = () => screen.getByRole('button', { name: 'Choose task start time' })
const blocked = () => screen.getByTestId('blocked').textContent

it('labels the trigger with the chosen start, authoritative once checked', async () => {
  vi.mocked(previewDeferredStart).mockResolvedValue({ ...preview, notBefore: '2099-01-06T18:00:00Z' })
  render(<Harness />)
  expect(trigger().textContent).toBe('Now')
  fireEvent.click(trigger())
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  expect(trigger().textContent).toBe('After reset')
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  await waitFor(() => expect(trigger().textContent).toBe('After reset · Tue 6 Jan 18:00 · UTC'))
  expect(trigger().getAttribute('title')).toContain('UTC')
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  expect(trigger().textContent).toBe('Pick a date')
  fireEvent.change(screen.getByLabelText('Time (server time zone)'), { target: { value: '18:00' } })
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-06' } })
  expect(trigger().textContent).toBe('Starts Tue 6 Jan 18:00')
})

it('keeps the entered date and time when Pick date is chosen again', async () => {
  render(<Harness />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-06' } })
  fireEvent.change(screen.getByLabelText('Time (server time zone)'), { target: { value: '18:30' } })
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-01-06')
  expect((screen.getByLabelText('Time (server time zone)') as HTMLInputElement).value).toBe('18:30')
})

it('previews a complete future date and time by itself, but not a past one', async () => {
  vi.mocked(previewDeferredStart).mockResolvedValue(preview)
  render(<Harness />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2000-01-01' } })
  await new Promise(resolve => setTimeout(resolve, AUTO_PREVIEW_MS + 100))
  expect(previewDeferredStart).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
  await screen.findByText(/Earliest start:/, undefined, { timeout: AUTO_PREVIEW_MS + 1000 })
  expect(previewDeferredStart).toHaveBeenCalledTimes(1)
  expect(vi.mocked(previewDeferredStart).mock.calls[0]![0].start).toEqual({ kind: 'at', date: '2099-01-01', hour: 9, minute: 0 })
})

it('reports why scheduling cannot submit yet, and nothing once it can', async () => {
  let finish!: (value: DeferredPreview) => void
  vi.mocked(previewDeferredStart).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<Reporting />)
  expect(blocked()).toBe('')
  fireEvent.click(trigger())
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  expect(blocked()).toBe('Pick a date to schedule this task.')
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('After usage limit resets'))
  expect(blocked()).toBe('Check the start time to schedule this task.')
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  expect(blocked()).toBe('Checking the start time…')
  await act(async () => finish({ available: false, reason: 'no-data', message: 'No observed reset.' }))
  expect(blocked()).toBe('No observed reset.')
  fireEvent.click(screen.getByRole('button', { name: 'Check start time' }))
  await act(async () => finish(preview))
  expect(blocked()).toBe('')
  view.rerender(<Reporting disabledReason="Remove attachments to schedule this task." />)
  expect(blocked()).toBe('Remove attachments to schedule this task.')
})

it('never offers a manual check for dates and does not turn an empty time into midnight', async () => {
  vi.mocked(previewDeferredStart).mockResolvedValue(preview)
  render(<Reporting />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  expect(screen.queryByRole('button', { name: 'Check start time' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Time (server time zone)'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, AUTO_PREVIEW_MS + 100)) })
  expect(previewDeferredStart).not.toHaveBeenCalled()
  expect(blocked()).toContain('Enter a complete time')
  expect((screen.getByLabelText('Time (server time zone)') as HTMLInputElement).value).toBe('')
  expect(screen.getByLabelText('Date').getAttribute('aria-invalid')).not.toBe('true')
  fireEvent.change(screen.getByLabelText('Time (server time zone)'), { target: { value: '22:00' } })
  await screen.findByText(/Earliest start:/)
  expect(vi.mocked(previewDeferredStart).mock.calls[0]![0].start).toEqual({ kind: 'at', date: '2099-01-01', hour: 22, minute: 0 })
  expect(screen.queryByRole('button', { name: 'Refresh preview' })).toBeNull()
})

it('provides a safe retry for a failed automatic date check without exposing raw API errors', async () => {
  vi.mocked(previewDeferredStart).mockRejectedValueOnce(new Error('start.date: Invalid string: must match pattern /^\\d{4}/'))
    .mockResolvedValueOnce(preview)
  render(<Reporting />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
  const error = await screen.findByRole('alert')
  expect(error.textContent).toBe('Could not check the start time. Try again.')
  expect(screen.getByLabelText('Date').getAttribute('aria-invalid')).not.toBe('true')
  expect(screen.getByLabelText('Time (server time zone)').getAttribute('aria-invalid')).not.toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText(/Earliest start:/)
  expect(previewDeferredStart).toHaveBeenCalledTimes(2)
  // The parent receives readiness through a passive effect after the preview renders.
  await waitFor(() => expect(blocked()).toBe(''))
})


it.each([
  { date: '10000-01-01', hour: 9, minute: 0, error: 'Enter a complete, valid date.' },
  { date: '2099-02-30', hour: 9, minute: 0, error: 'Enter a complete, valid date.' },
  { date: '2099-01-01', hour: 24, minute: 0, error: 'Enter a complete time.' },
])('keeps invalid draft fields off the wire: $date $hour:$minute', async ({ error, ...fields }) => {
  render(<StartTimePicker task={task} value={{ start: { kind: 'at', ...fields } }} onChange={() => {}} />)
  fireEvent.click(trigger())
  fireEvent.blur(screen.getByLabelText('Date'))
  expect(screen.getByRole('alert').textContent).toBe(error)
  expect(trigger().textContent).not.toContain('Invalid Date')
  await new Promise(resolve => setTimeout(resolve, AUTO_PREVIEW_MS + 100))
  expect(previewDeferredStart).not.toHaveBeenCalled()
})

it('retries an HTTP 200 account-unverifiable date result with unchanged inputs', async () => {
  vi.mocked(previewDeferredStart)
    .mockResolvedValueOnce({ available: false, reason: 'account-unverifiable', message: 'The signed-in Codex account cannot be checked right now. Retry the preview.' })
    .mockResolvedValueOnce(preview)
  render(<Reporting />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText(/Earliest start:/)
  expect(previewDeferredStart).toHaveBeenCalledTimes(2)
  expect(vi.mocked(previewDeferredStart).mock.calls[1]).toEqual(vi.mocked(previewDeferredStart).mock.calls[0])
  expect(screen.queryByRole('button', { name: 'Check start time' })).toBeNull()
})

it.each(['at', 'usage-reset'] as const)('expires %s readiness at notBefore while retaining the choice', async kind => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2099-01-01T08:59:59Z'))
    vi.mocked(previewDeferredStart).mockResolvedValue(preview)
    render(<Reporting />)
    fireEvent.click(trigger())
    if (kind === 'at') {
      fireEvent.click(screen.getByLabelText('Pick date & time'))
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_PREVIEW_MS) })
    } else {
      await act(async () => {})
      fireEvent.click(screen.getByLabelText('After usage limit resets'))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check start time' })) })
    }
    expect(blocked()).toBe('')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(blocked()).toContain('passed')
    expect(trigger().textContent).not.toBe('Now')
    fireEvent.click(trigger())
    expect(screen.queryByText(/Earliest start:/)).toBeNull()
    if (kind === 'at') expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-01-01')
  } finally { vi.useRealTimers() }
})

it('keeps an untouched date neutral while blocking incomplete submission', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose task start time' }))
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  expect(screen.getByLabelText('Date', { exact: true }).getAttribute('aria-invalid')).not.toBe('true')
  expect(screen.queryByRole('alert')).toBeNull()
})
it('includes day and server zone in a collapsed reset summary', () => {
  expect(startLabel({ start: { kind: 'usage-reset' } }, preview)).toContain('Jan')
  expect(startLabel({ start: { kind: 'usage-reset' } }, preview)).toContain('UTC')
})

it('shows resolved eligibility and server zone before any usage check', async () => {
  vi.mocked(getDeferredStartOptions).mockResolvedValue({ timeZone: 'Europe/Warsaw', usageReset: { available: false, reason: 'unsupported', message: 'Reset scheduling supports Claude and Codex. Choose a date and time.' } })
  render(<Harness text="" />)
  expect(getDeferredStartOptions).not.toHaveBeenCalled()
  fireEvent.click(trigger())
  await screen.findByText(/Reset scheduling supports/)
  expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  await screen.findByText('Server time zone: Europe/Warsaw')
  expect(previewDeferredStart).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Check start time' })).toBeNull()
})

it('keeps reset intent when changed execution is unsupported, and ignores stale options', async () => {
  let finish!: (value: Awaited<ReturnType<typeof getDeferredStartOptions>>) => void
  const onChange = vi.fn()
  const value: StartChoice = { start: { kind: 'usage-reset' } }
  const view = render(<StartTimePicker task={task} value={value} onChange={onChange} />)
  fireEvent.click(trigger())
  await waitFor(() => expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(false))
  vi.mocked(getDeferredStartOptions).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  view.rerender(<StartTimePicker task={{ ...task, runner: 'codex' }} value={value} onChange={onChange} />)
  vi.mocked(getDeferredStartOptions).mockResolvedValueOnce({ timeZone: 'UTC', usageReset: { available: false, reason: 'unsupported', message: 'Unsupported workflow' } })
  view.rerender(<StartTimePicker task={{ ...task, runner: 'opencode' }} value={value} onChange={onChange} />)
  await screen.findByText('Unsupported workflow')
  await act(async () => finish({ timeZone: 'UTC', usageReset: { available: true, provider: 'codex' } }))
  expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByLabelText('After usage limit resets') as HTMLInputElement).checked).toBe(true)
  expect(screen.queryByRole('button', { name: 'Check start time' })).toBeNull()
  expect(onChange).not.toHaveBeenCalledWith(null)
  expect(previewDeferredStart).not.toHaveBeenCalled()
})

it('recovers metadata failure without a model call or a date check button', async () => {
  vi.mocked(getDeferredStartOptions).mockRejectedValueOnce(new Error('offline'))
  render(<Harness />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByLabelText('Pick date & time'))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry options' }))
  await screen.findByText('Server time zone: Europe/Warsaw')
  expect(previewDeferredStart).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Check start time' })).toBeNull()
})

it('resolves changed reset eligibility while the picker is closed', async () => {
  const value: StartChoice = { start: { kind: 'usage-reset' } }
  const view = render(<StartTimePicker task={task} value={value} onChange={() => {}} />)
  await waitFor(() => expect(getDeferredStartOptions).toHaveBeenCalledTimes(1))
  view.rerender(<StartTimePicker task={{ ...task, task: 'A different prompt' }} value={value} onChange={() => {}} />)
  expect(getDeferredStartOptions).toHaveBeenCalledTimes(1)
  view.rerender(<StartTimePicker task={{ ...task, runner: 'codex' }} value={value} onChange={() => {}} />)
  await waitFor(() => expect(getDeferredStartOptions).toHaveBeenCalledTimes(2))
  expect(previewDeferredStart).not.toHaveBeenCalled()
})
