import { BotIcon, PlusIcon } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router'

import { orderManagers, useManagers } from '@/api/managers'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { useNow } from '@/lib/use-now'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { carriesComposerFocus, FOCUS_COMPOSER } from './manager-focus'
import { ManagerIndexLoading } from './manager-loading'
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

/** Approvals first, then `orderManagers`' recency: a sort of the same order, because desktop
 *  `/manager` and the palette rely on that one staying most-recent-first. */
function pendingFirst(managers: readonly ManagerSummary[]): ManagerSummary[] {
  return [...managers].sort((a, b) => Number(b.pendingActions > 0) - Number(a.pendingActions > 0))
}

/** The phone has no sidebar column, so its list is a screen (spec, Surface). */
function ManagerListScreen({ managers }: { managers: readonly ManagerSummary[] }) {
  const now = useNow(60_000)
  return (
    <div data-route="manager-list" className="flex flex-col gap-0.5 p-2">
      <h1 className="sr-only">Managers</h1>
      {pendingFirst(managers).map((manager) => <ManagerRow key={manager.id} manager={manager} active={false} now={now} />)}
      <Button asChild variant="ghost" className="mt-1 justify-start gap-2 text-muted-foreground">
        <Link to="/manager/new">
          <PlusIcon aria-hidden="true" className="size-4" />
          New manager
        </Link>
      </Button>
    </div>
  )
}

/** `/manager`: the most recent chat, the list with `?all=1` or several on a phone, or the first-run
 *  setup. `all=1` is the chat's back arrow: one manager must not loop straight back into it. */
export function ManagerIndexRoute() {
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  const desktop = useDesktopViewport()
  const [params] = useSearchParams()
  const location = useLocation()
  const ordered = useMemo(() => orderManagers(managers.data?.managers ?? []), [managers.data])
  // The first-run form's create lands here before its own navigate can say where focus goes.
  const [firstRun, setFirstRun] = useState(false)
  if (managers.data && ordered.length === 0 && !firstRun) setFirstRun(true)
  if (managers.isError) return <CenteredState icon={<BotIcon aria-hidden="true" />} tone="danger" title="Managers are unavailable" subtitle={managers.error.message} />
  if (!managers.data) return <ManagerIndexLoading />
  if (ordered.length === 0) return <ManagerNewRoute />
  if (params.get('all') === '1' || (!desktop && ordered.length > 1)) return <ManagerListScreen managers={ordered} />
  // A delete lands here on its way to the next chat, as does a first-run create: pass focus on.
  return <Navigate to={`/manager/${encodeURIComponent(ordered[0]!.id)}`} replace {...(firstRun || carriesComposerFocus(location.state) ? { state: FOCUS_COMPOSER } : {})} />
}
