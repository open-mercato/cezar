import { useSyncExternalStore } from 'react'

/** Settings, Appearance: whether the task header shows the live usage gauges. Per browser,
 *  like the theme; on unless switched off. */
export const LIVE_USAGE_STORAGE_KEY = 'cez-live-usage'
const CHANGE_EVENT = 'cez-live-usage-change'

export function readLiveUsageEnabled(): boolean {
  try {
    return localStorage.getItem(LIVE_USAGE_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeLiveUsageEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LIVE_USAGE_STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // Private mode / storage full: the choice still applies to this page through the event.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function useLiveUsageEnabled(): boolean {
  return useSyncExternalStore(subscribe, readLiveUsageEnabled, () => true)
}
