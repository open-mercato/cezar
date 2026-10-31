import { BotIcon, PlusIcon } from 'lucide-react'
import { useMemo, useSyncExternalStore } from 'react'
import { Link, Navigate } from 'react-router'

import { orderManagers, useManagers } from '@/api/managers'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerRow } from './manager-sidebar'
import { ManagerNewRoute } from './manager-new'

const DESKTOP = '(min-width: 768px)'

/** No `matchMedia` (a prerender, a bare test) reads as desktop: the sidebar has the list there. */
function useDesktopViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia?.(DESKTOP)
      query?.addEventListener('change', notify)
      return () => query?.removeEventListener('change', notify)
    },
    () => window.matchMedia?.(DESKTOP).matches ?? true,
  )
}

/** The phone has no sidebar column, so its list is a screen (spec, Surface). */
function ManagerListScreen({ managers }: { managers: readonly ManagerSummary[] }) {
  const now = new Date()
  return (
    <div data-route="manager-list" className="flex flex-col gap-0.5 p-2">
      {managers.map((manager) => <ManagerRow key={manager.id} manager={manager} active={false} now={now} />)}
      <Button asChild variant="ghost" className="mt-1 justify-start gap-2 text-muted-foreground">
        <Link to="/manager/new">
          <PlusIcon aria-hidden="true" className="size-4" />
          New manager
        </Link>
      </Button>
    </div>
  )
}

/** `/manager`: the most recent chat, the list on a phone, or the first-run setup. */
export function ManagerIndexRoute() {
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  const desktop = useDesktopViewport()
  const ordered = useMemo(() => orderManagers(managers.data?.managers ?? []), [managers.data])
  if (managers.isError) return <CenteredState icon={<BotIcon aria-hidden="true" />} tone="danger" title="Managers are unavailable" subtitle={managers.error.message} />
  if (!managers.data) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (ordered.length === 0) return <ManagerNewRoute />
  if (!desktop) return <ManagerListScreen managers={ordered} />
  return <Navigate to={`/manager/${encodeURIComponent(ordered[0]!.id)}`} replace />
}
