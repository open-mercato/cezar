import { enterInsertsNewline } from '@/lib/enter-key'

/** Navigation state from create and delete: the next chat's composer takes focus, not <body>. */
export const FOCUS_COMPOSER = { focusComposer: true } as const

export function carriesComposerFocus(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { focusComposer?: unknown }).focusComposer === true
}

/** Never on a phone: focusing the field would raise its keyboard over the new chat. */
export function shouldFocusComposer(state: unknown): boolean {
  return carriesComposerFocus(state) && !enterInsertsNewline()
}

/** Router state from the phone list's rows: the chat's ← can go back to it instead of pushing. */
export const FROM_MANAGER_LIST = { fromManagerList: true } as const

export function cameFromManagerList(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { fromManagerList?: unknown }).fromManagerList === true
}

/** Router state from a sidebar row's Settings…: the chat opens with its gear menu open. */
export const OPEN_MANAGER_SETTINGS = { openSettings: true } as const

export function opensManagerSettings(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { openSettings?: unknown }).openSettings === true
}
