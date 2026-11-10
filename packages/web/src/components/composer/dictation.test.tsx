import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { onDangerToast, resetToasts, Toaster } from '@/components/ui/toaster'
import { reportDictationFailed } from '@/lib/telemetry'

import { Composer } from './composer'
import {
  DICTATION_INSECURE,
  DICTATION_NO_SERVICE,
  DICTATION_OLD_SHELL,
  dictationNotice,
  foldResults,
  formatElapsed,
  resetDictationAvailability,
  type SpeechRecognitionLike,
  type SpeechResultEventLike,
} from './dictation'

vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  reportDictationFailed: vi.fn(),
}))

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
  vi.mocked(reportDictationFailed).mockClear()
  resetDictationAvailability()
})

describe('dictationNotice', () => {
  it('maps Web Speech codes to what the user can do, and which ones are failures', () => {
    expect(dictationNotice('aborted')).toBeNull()
    expect(dictationNotice('no-speech')?.failure).toBeNull()
    // Refusals are the user's/browser's answer, not failures (telemetry c55c7b0b).
    expect(dictationNotice('not-allowed')?.failure).toBeNull()
    expect(dictationNotice('service-not-allowed')?.failure).toBeNull()
    expect(dictationNotice('audio-capture')?.failure).toBe('audio-capture')
    expect(dictationNotice('network')?.failure).toBe('network')
    expect(dictationNotice(undefined)).toEqual({ message: 'Dictation failed', failure: 'unknown' })
  })
})

/** A scriptable Web Speech stand-in: tests drive `onresult`/`onerror` by hand — exactly the
 *  seam the adapter promises (`speechRecognitionCtor` reads the global at call time). */
class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = []
  static failOnStart = false
  lang = ''
  continuous = false
  interimResults = false
  started = false
  stopped = false
  aborted = false
  onresult: ((event: SpeechResultEventLike) => void) | null = null
  onerror: ((event: { error?: string }) => void) | null = null
  onend: (() => void) | null = null

  start(): void {
    if (FakeRecognition.failOnStart) throw new Error('not allowed')
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  abort(): void {
    this.aborted = true
  }
}

function stubSpeech() {
  FakeRecognition.instances = []
  FakeRecognition.failOnStart = false
  const Ctor = class extends FakeRecognition {
    constructor() {
      super()
      FakeRecognition.instances.push(this)
    }
  }
  vi.stubGlobal('SpeechRecognition', Ctor)
}

const result = (transcript: string, isFinal: boolean, resultIndex = 0): SpeechResultEventLike => ({
  resultIndex,
  results: [{ isFinal, 0: { transcript } }],
})

function renderComposer(onSubmit = vi.fn(() => Promise.resolve({}))) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Composer onSubmit={onSubmit} />
      <Toaster />
    </QueryClientProvider>,
  )
  return { onSubmit, textarea: screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement }
}

const startDictation = () => {
  fireEvent.click(screen.getByLabelText('Start dictation'))
  return FakeRecognition.instances.at(-1)!
}

describe('foldResults — pure transcript folding', () => {
  it('finals accumulate, interims replace the tail', () => {
    let state = foldResults('', { resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hel' } }] })
    expect(state).toEqual({ finalText: '', interim: 'hel' })
    state = foldResults(state.finalText, { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello ' } }] })
    expect(state).toEqual({ finalText: 'hello ', interim: '' })
    state = foldResults(state.finalText, {
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: 'hello ' } }, // already folded — before resultIndex
        { isFinal: false, 0: { transcript: 'wor' } },
      ],
    })
    expect(state).toEqual({ finalText: 'hello ', interim: 'wor' })
  })
})

describe('formatElapsed', () => {
  it('renders mm:ss', () => {
    expect(formatElapsed(0, 0)).toBe('0:00')
    expect(formatElapsed(0, 61_000)).toBe('1:01')
    expect(formatElapsed(0, 600_000)).toBe('10:00')
  })
})

describe('the dictation overlay (paseo pattern)', () => {
  it('the mic renders labeled "Dictation" when the API exists, left of send', () => {
    stubSpeech()
    renderComposer()
    const mic = screen.getByLabelText('Start dictation')
    expect(mic.textContent).toContain('Dictation')
    const bar = mic.parentElement!
    const children = [...bar.children]
    expect(children.indexOf(mic)).toBeLessThan(children.indexOf(screen.getByLabelText('Send')))
  })

  it('recording swaps the footer for the overlay: timer, pulsing dot, growing partial transcript', () => {
    stubSpeech()
    renderComposer()
    const recognition = startDictation()
    expect(recognition.started).toBe(true)
    expect(recognition.interimResults).toBe(true)
    expect(recognition.continuous).toBe(true)

    const overlay = document.querySelector('[data-slot="dictation-overlay"]')!
    expect(overlay).not.toBeNull()
    expect(screen.queryByLabelText('Send')).toBeNull() // the footer is REPLACED
    expect(overlay.querySelector('[data-slot="dictation-timer"]')!.textContent).toBe('0:00')
    expect(overlay.textContent).toContain('Listening…')

    act(() => recognition.onresult!(result('summarize the', false)))
    expect(document.querySelector('[data-slot="dictation-transcript"]')!.textContent).toBe('summarize the')
    act(() => recognition.onresult!(result('summarize the thread', true)))
    expect(document.querySelector('[data-slot="dictation-transcript"]')!.textContent).toBe(
      'summarize the thread',
    )
  })

  it('✓ insert puts the transcript into the textarea (appended to a draft) and stops the mic', () => {
    stubSpeech()
    const { textarea } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'Also:' } })
    const recognition = startDictation()
    act(() => recognition.onresult!(result('check the tests', true)))
    fireEvent.click(screen.getByLabelText('Insert transcription'))

    expect(textarea.value).toBe('Also: check the tests')
    expect(recognition.stopped).toBe(true)
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
  })

  it('↑ insert-and-send submits the transcript in one tap', async () => {
    stubSpeech()
    const { onSubmit } = renderComposer()
    const recognition = startDictation()
    act(() => recognition.onresult!(result('ship it', true)))
    fireEvent.click(screen.getByLabelText('Insert transcription and send'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('ship it', []))
  })

  it('✕ cancel aborts and restores the footer without touching the draft', () => {
    stubSpeech()
    const { textarea } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'my draft' } })
    const recognition = startDictation()
    act(() => recognition.onresult!(result('noise', false)))
    fireEvent.click(screen.getByLabelText('Cancel dictation'))

    expect(recognition.aborted).toBe(true)
    expect(textarea.value).toBe('my draft')
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
    expect(screen.getByLabelText('Send')).toBeTruthy()
  })

  it('a recognition error surfaces the browser word as a toast and returns to idle', async () => {
    stubSpeech()
    renderComposer()
    const recognition = startDictation()
    act(() => recognition.onerror!({ error: 'bad-grammar' }))
    expect(await screen.findByText('Dictation failed — bad-grammar')).toBeTruthy()
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
    expect(recognition.aborted).toBe(true)
    expect(reportDictationFailed).toHaveBeenCalledWith('bad-grammar')
  })

  // telemetry 38ccdbdc / 252d00a6: every code is one report under one fingerprint, never the
  // generic danger-toast report whose group is the message text.
  // telemetry c55c7b0b (regressed in 0.16.2 from Android Chrome): a refused microphone is the
  // user's or the browser's choice — an actionable notice, never a reported failure.
  it('a refused microphone says what to do and reports nothing', async () => {
    stubSpeech()
    const toastReports: string[] = []
    const off = onDangerToast((message) => toastReports.push(message))
    renderComposer()
    act(() => startDictation().onerror!({ error: 'not-allowed' }))
    expect(await screen.findByText("Microphone blocked — allow it for this site in the browser's site settings")).toBeTruthy()
    expect(reportDictationFailed).not.toHaveBeenCalled()
    expect(toastReports).toEqual([])
    // Not a dead end: the user can unblock the site and try again without a reload.
    expect(screen.getByLabelText('Start dictation').getAttribute('aria-disabled')).not.toBe('true')
    off()
  })

  it('a refusing speech service is not reported either', async () => {
    stubSpeech()
    renderComposer()
    act(() => startDictation().onerror!({ error: 'service-not-allowed' }))
    expect(await screen.findByText(DICTATION_NO_SERVICE)).toBeTruthy()
    expect(reportDictationFailed).not.toHaveBeenCalled()
  })

  it('no-speech is a plain notice, not a reported failure; aborted is silent', async () => {
    stubSpeech()
    renderComposer()
    act(() => startDictation().onerror!({ error: 'aborted' }))
    expect(document.querySelector('[data-tone="danger"]')).toBeNull()
    act(() => startDictation().onerror!({ error: 'no-speech' }))
    const toast = (await screen.findByText('Dictation heard nothing — try again')).closest('[data-tone]')
    expect(toast?.getAttribute('data-tone')).toBe('default')
    expect(reportDictationFailed).not.toHaveBeenCalled()
  })

  it('a speech service that refuses disables the mic for the session, saying why', async () => {
    stubSpeech()
    renderComposer()
    act(() => startDictation().onerror!({ error: 'service-not-allowed' }))
    expect(await screen.findByText(DICTATION_NO_SERVICE)).toBeTruthy()
    const mic = screen.getByLabelText('Start dictation')
    expect(mic.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(mic)
    expect(FakeRecognition.instances).toHaveLength(1) // no second attempt
    // A fresh composer (another task, the new-task form) must not offer it again.
    cleanup()
    renderComposer()
    expect(screen.getByLabelText('Start dictation').getAttribute('aria-disabled')).toBe('true')
  })

  it('in an insecure context the mic is disabled with the reason, never started', async () => {
    stubSpeech()
    vi.stubGlobal('isSecureContext', false)
    // The reason is a Radix tooltip, positioned by floating-ui; jsdom has no ResizeObserver.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    renderComposer()
    const mic = screen.getByLabelText('Start dictation')
    expect(mic.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(mic)
    expect(FakeRecognition.instances).toHaveLength(0)
    act(() => mic.focus())
    expect((await screen.findAllByText(DICTATION_INSECURE)).length).toBeGreaterThan(0)
  })

  // telemetry c55c7b0b: a macOS shell without the microphone entitlement refuses every start.
  it('in a macOS app that predates the microphone entitlement the mic is disabled, never started', async () => {
    stubSpeech()
    vi.stubGlobal('__CEZ_DESKTOP__', { platform: 'macos' })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    renderComposer()
    const mic = screen.getByLabelText('Start dictation')
    expect(mic.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(mic)
    expect(FakeRecognition.instances).toHaveLength(0)
    act(() => mic.focus())
    expect((await screen.findAllByText(DICTATION_OLD_SHELL)).length).toBeGreaterThan(0)
  })

  it('in a macOS app with the entitlement a refusal points at System Settings, not the browser', async () => {
    stubSpeech()
    vi.stubGlobal('__CEZ_DESKTOP__', { platform: 'macos', microphone: true })
    renderComposer()
    act(() => startDictation().onerror!({ error: 'not-allowed' }))
    expect(await screen.findByText(/System Settings → Privacy & Security/)).toBeTruthy()
    expect(reportDictationFailed).not.toHaveBeenCalled()
  })

  it('a mic that will not start (permissions) toasts honestly instead of hanging the overlay', async () => {
    stubSpeech()
    FakeRecognition.failOnStart = true
    renderComposer()
    fireEvent.click(screen.getByLabelText('Start dictation'))
    expect(
      await screen.findByText('Dictation failed — the microphone could not be started'),
    ).toBeTruthy()
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
  })
})
