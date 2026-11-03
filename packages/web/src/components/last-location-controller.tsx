import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { useProjects } from '@/api/queries'
import {
  locationToSave,
  readStoredLastLocation,
  sameLastLocation,
  writeStoredLastLocation,
} from '@/lib/last-location'
import { recordSettingsReturn } from '@/lib/settings-return'

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

  // The settings frame's way back (spec 2026-10-13-unified-settings): every non-settings page
  // is a candidate, settings pages never are. Independent of the persisted lastLocation below —
  // that one is project-scoped and server-backed, this one is any page and memory-only.
  useEffect(() => {
    recordSettingsReturn(location)
  }, [location])

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
