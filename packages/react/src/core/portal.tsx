import { createContext, useContext } from 'react'

export const CezarPortalContext = createContext<HTMLElement | null | undefined>(undefined)

/** The provider-owned overlay surface, null only before its first committed ref. */
export function useCezarPortal(): HTMLElement | null {
  const portal = useContext(CezarPortalContext)
  if (portal === undefined) {
    throw new Error('cezar: useCezarPortal() must be called inside <CezarProvider>')
  }
  return portal
}
