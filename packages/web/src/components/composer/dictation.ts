import * as React from 'react'

/**
 * Dictation (spec §composer intelligence; the paseo pattern, `paseo-ui.md` §5): STT-only,
 * push-to-talk into the text box — never a hands-free voice mode. The composer shows a mic
 * labeled **Dictation**; recording swaps the composer footer for an overlay (pulsing
 * indicator, mm:ss timer, growing partial transcript, cancel / insert / insert-and-send).
 *
 * The browser seam is the Web Speech API. This module wraps it structurally so:
 *  - support detection is one honest function (mic hidden entirely when absent — no fake), and
 *  - tests stub `window.SpeechRecognition` with a plain class and drive `onresult`/`onerror`
 *    directly, no vendor globals or DOM events required.
 */

/** One recognized alternative. */
interface SpeechAlternativeLike {
  transcript: string
}

/** One result: indexable (best alternative at 0) + finality flag. */
interface SpeechResultLike {
  readonly isFinal: boolean
  readonly [index: number]: SpeechAlternativeLike
}

export interface SpeechResultEventLike {
  readonly resultIndex: number
  readonly results: {
    readonly length: number
    readonly [index: number]: SpeechResultLike
  }
}

/** The structural subset of `SpeechRecognition` the hook drives. */
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechResultEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** The one place the vendor globals are read — at call time, so a test that stubs the global
 *  before clicking the mic is enough. Chrome/Safari ship the `webkit` name; Firefox neither. */
export function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export interface DictationState {
  /** Everything finalized so far + the current interim tail — what the overlay shows and what
   *  insert/insert-and-send deliver. */
  transcript: string
  /** Epoch ms when recording started — the overlay derives its mm:ss from it. */
  startedAt: number
}

export interface Dictation {
  /** undefined ⇒ the API is absent; the mic must not render at all. */
  supported: boolean
  /** null ⇒ idle. */
  recording: DictationState | null
  start(): void
  /** ✕ — discard everything, back to idle. */
  cancel(): void
  /** ✓ / ↑ — stop and hand back the transcript (possibly '' when nothing was heard). */
  finish(): string
}

/** Fold a result event into (final, interim): results before `resultIndex` are already folded;
 *  from it on, finals append and interims replace the tail. Exported for the table test. */
export function foldResults(
  finalText: string,
  event: SpeechResultEventLike,
): { finalText: string; interim: string } {
  let finals = finalText
  let interim = ''
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i]!
    const piece = result[0]?.transcript ?? ''
    if (result.isFinal) finals += piece
    else interim += piece
  }
  return { finalText: finals, interim }
}

export function useDictation(onError: (message: string) => void): Dictation {
  const [recording, setRecording] = React.useState<DictationState | null>(null)
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null)
  const finalRef = React.useRef('')
  // The mic renders (or not) per browser capability; the ctor itself is re-read on start so a
  // test stub installed after mount still wins.
  const [supported] = React.useState(() => speechRecognitionCtor() !== undefined)

  const teardown = React.useCallback(() => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    finalRef.current = ''
    setRecording(null)
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.abort()
    }
  }, [])

  // An unmounted composer must not keep the mic hot.
  React.useEffect(() => teardown, [teardown])

  const start = React.useCallback(() => {
    if (recognitionRef.current) return
    const Ctor = speechRecognitionCtor()
    if (!Ctor) return
    let recognition: SpeechRecognitionLike
    try {
      recognition = new Ctor()
      recognition.lang = navigator.language || 'en-US'
      recognition.continuous = true
      recognition.interimResults = true
      const startedAt = Date.now()
      recognition.onresult = (event) => {
        const folded = foldResults(finalRef.current, event)
        finalRef.current = folded.finalText
        setRecording({ transcript: folded.finalText + folded.interim, startedAt })
      }
      recognition.onerror = (event) => {
        // `no-speech` etc. — surface the browser's own word, then back to idle honestly.
        onError(`Dictation failed${event.error ? ` — ${event.error}` : ''}`)
        teardown()
      }
      recognition.start()
      recognitionRef.current = recognition
      setRecording({ transcript: '', startedAt })
    } catch {
      onError('Dictation failed — the microphone could not be started')
      teardown()
    }
  }, [onError, teardown])

  const cancel = React.useCallback(() => teardown(), [teardown])

  const finish = React.useCallback((): string => {
    const recognition = recognitionRef.current
    const transcript = (finalRef.current + '').trim() === '' ? '' : finalRef.current
    // Prefer what the state saw last (finals + interim tail): stop() would eventually finalize
    // the tail, but the user already chose to take what is on screen.
    const onScreen = recording?.transcript ?? transcript
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.stop()
    }
    recognitionRef.current = null
    finalRef.current = ''
    setRecording(null)
    return onScreen.trim()
  }, [recording])

  return { supported, recording, start, cancel, finish }
}

/** mm:ss for the overlay timer. */
export function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
