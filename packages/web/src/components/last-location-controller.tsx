import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { useProjects } from '@/api/queries'
import {
  locationToSave,
  readStoredLastLocation,
  sameLastLocation,
  writeStoredLastLocation,
} from '@/lib/last-location'

/**
 * Remembers settled project-scoped navigation for the next exact-bare-root launch, in THIS
 * browser's localStorage (`lib/last-location.ts`).
 *
 * This controller lives once beside the routed tree: global settings and legacy paths are
 * ignored by `locationToSave`, while valid registered project URLs are mirrored to storage as
 * they settle. Storing it per browser is the point — the workspace file gave every client one
 * shared answer, so a phone browsing one project moved where the desktop's next launch landed.
 *
 * The write is synchronous and local, so there is no debounce and no in-flight ordering to
 * protect: a redirect chain simply overwrites its own intermediate values, and the last
 * navigation wins because it runs last.
 */
export function LastLocationController(): null {
  const location = useLocation()
  const projects = useProjects()

  useEffect(() => {
    const next = locationToSave(location, projects.data)
    if (next === null) return
    // Cheap, but not free: skipping the equal write keeps a re-render storm off the disk-backed
    // storage, and keeps the stored JSON byte-identical across a reload.
    if (sameLastLocation(readStoredLastLocation(), next)) return
    writeStoredLastLocation(next)
  }, [
    location.hash,
    location.pathname,
    location.search,
    projects.data,
  ])

  return null
}
