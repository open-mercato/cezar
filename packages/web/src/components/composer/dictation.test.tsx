import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'

import { Composer } from './composer'
import {
  foldResults,
  formatElapsed,
  type SpeechRecognitionLike,
  type SpeechResultEventLike,
} from './dictation'

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
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
    act(() => recognition.onerror!({ error: 'no-speech' }))
    expect(await screen.findByText('Dictation failed — no-speech')).toBeTruthy()
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
    expect(recognition.aborted).toBe(true)
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
