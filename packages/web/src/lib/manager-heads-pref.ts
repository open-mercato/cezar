import { useSyncExternalStore } from 'react'

/** Settings → Notifications: whether a manager that needs you pops up in the corner of task
 *  pages. Per browser, like the theme; on unless switched off. */
export const MANAGER_HEADS_STORAGE_KEY = 'cez-manager-heads'
const CHANGE_EVENT = 'cez-manager-heads-change'

export function readManagerHeadsEnabled(): boolean {
  try {
    return localStorage.getItem(MANAGER_HEADS_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeManagerHeadsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(MANAGER_HEADS_STORAGE_KEY, enabled ? 'on' : 'off')
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

export function useManagerHeadsEnabled(): boolean {
  return useSyncExternalStore(subscribe, readManagerHeadsEnabled, () => true)
}
