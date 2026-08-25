import { createContext, useContext } from 'react'

export const CezarPortalContext = createContext<HTMLElement | null | undefined>(undefined)

/**
 * The provider portal when available; `undefined` means the caller is outside CezarProvider.
 * Overlay wrappers use this to retain their legacy standalone body fallback without weakening
 * the strict public hook below.
 */
export function useOptionalCezarPortal(): HTMLElement | null | undefined {
  return useContext(CezarPortalContext)
}

/** The provider-owned overlay surface, null only before its first committed ref. */
export function useCezarPortal(): HTMLElement | null {
  const portal = useOptionalCezarPortal()
  if (portal === undefined) {
    throw new Error('cezar: useCezarPortal() must be called inside <CezarProvider>')
  }
  return portal
}
