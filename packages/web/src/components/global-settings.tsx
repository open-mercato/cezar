import * as React from 'react'

import type { SettingsSectionId } from '@/routes/settings/registry'

/**
 * Global settings are a dialog over whatever you were doing, not a page: they are about cezar
 * itself (appearance, notifications, resources, the project registry, agent accounts), so
 * opening them should not cost you your place. Anything may open it — the rail's menu, the
 * command palette, a link inside project settings — optionally straight onto one section.
 */
type GlobalSettingsValue = {
  open: (section?: SettingsSectionId) => void
  close: () => void
  /** The section on screen, or null while the dialog is closed. */
  section: SettingsSectionId | null
  isOpen: boolean
}

const GlobalSettingsContext = React.createContext<GlobalSettingsValue | null>(null)

export function useGlobalSettings(): GlobalSettingsValue {
  const value = React.useContext(GlobalSettingsContext)
  if (!value) throw new Error('useGlobalSettings must be used inside a <GlobalSettingsProvider>')
  return value
}

export function GlobalSettingsProvider({
  children,
  dialog,
}: {
  children: React.ReactNode
  /** The dialog itself, rendered inside the provider so it can read the state above. */
  dialog?: React.ReactNode
}) {
  const [state, setState] = React.useState<{ isOpen: boolean; section: SettingsSectionId | null }>({
    isOpen: false,
    section: null,
  })
  const value = React.useMemo<GlobalSettingsValue>(
    () => ({
      ...state,
      open: (section) => setState((current) => ({ isOpen: true, section: section ?? current.section })),
      close: () => setState((current) => ({ ...current, isOpen: false })),
    }),
    [state],
  )
  return (
    <GlobalSettingsContext.Provider value={value}>
      {children}
      {dialog}
    </GlobalSettingsContext.Provider>
  )
}
