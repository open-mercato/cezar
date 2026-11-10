import * as React from 'react'

/** Dictation language (#1807): per browser, like the other composer preferences — no server state. */
export const DICTATION_LANGUAGE_STORAGE_KEY = 'cez-dictation-language'

/** A short curated list of BCP-47 tags the Web Speech API serves well; the browser's own is added. */
const CURATED: ReadonlyArray<{ tag: string; label: string }> = [
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'en-GB', label: 'English (UK)' },
  { tag: 'pl-PL', label: 'Polski' },
  { tag: 'de-DE', label: 'Deutsch' },
  { tag: 'fr-FR', label: 'Français' },
  { tag: 'es-ES', label: 'Español' },
  { tag: 'it-IT', label: 'Italiano' },
  { tag: 'pt-BR', label: 'Português (Brasil)' },
  { tag: 'nl-NL', label: 'Nederlands' },
  { tag: 'uk-UA', label: 'Українська' },
  { tag: 'ja-JP', label: '日本語' },
  { tag: 'zh-CN', label: '中文' },
]

/** What nothing-picked means — the behavior before the picker existed. */
export function browserDictationLanguage(): string {
  return navigator.language || 'en-US'
}

export function dictationLanguageOptions(): Array<{ tag: string; label: string }> {
  const own = browserDictationLanguage()
  return CURATED.some((o) => o.tag === own) ? [...CURATED] : [{ tag: own, label: own }, ...CURATED]
}

export function readStoredDictationLanguage(): string | null {
  try {
    return localStorage.getItem(DICTATION_LANGUAGE_STORAGE_KEY) || null
  } catch {
    return null
  }
}

/** The chosen language (browser's own until the user picks) and its setter. */
export function useDictationLanguage(): [string, (tag: string) => void] {
  const [stored, setStored] = React.useState(readStoredDictationLanguage)
  const set = React.useCallback((tag: string) => {
    setStored(tag)
    try {
      localStorage.setItem(DICTATION_LANGUAGE_STORAGE_KEY, tag)
    } catch {
      // Private mode / storage full — the choice still applies for this page.
    }
  }, [])
  return [stored ?? browserDictationLanguage(), set]
}
