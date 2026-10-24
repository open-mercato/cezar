import { createContext, useContext } from 'react'

import type { EngineAlternatives, EnginePreset } from './follow-up-engine'

/** What the thread hands the agent-error hint card: the follow-up composer's engine presets (#401),
 *  live only on the run's latest hint while its session can be continued. */
export interface ErrorHintActions {
  /** The hint entry whose buttons are live; every older card renders its explanation only. */
  activeHintId: string | undefined
  alternatives: EngineAlternatives
  preset: (choice: EnginePreset) => void
}

export const ErrorHintActionsContext = createContext<ErrorHintActions | null>(null)

export function useErrorHintActions(): ErrorHintActions | null {
  return useContext(ErrorHintActionsContext)
}

/** Where a preset sends the user next: the composer whose Continue it changed. */
export function focusThreadComposer(): void {
  document.querySelector<HTMLTextAreaElement>('[data-slot="thread-dock"] [data-slot="composer"] textarea')?.focus()
}
