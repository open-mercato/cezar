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
