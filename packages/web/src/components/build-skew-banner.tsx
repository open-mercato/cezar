import { RefreshCwIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import { useScheduleSelfUpdate, useSelfUpdate } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { buildSkew, subscribeBuildSkew } from '@/lib/build-identity'

function inDesktopApp(): boolean {
  return typeof window !== 'undefined' && ('__CEZ_DESKTOP__' in window || !!document.documentElement.dataset.cezDesktop)
}

/** The cockpit and the server it talks to come from different builds (lib/build-identity.ts). */
export function BuildSkewBanner() {
  const skew = useSyncExternalStore(subscribeBuildSkew, buildSkew, () => null)
  if (!skew) return null
  return (
    <div
      role="status"
      data-slot="build-skew-banner"
      data-skew={skew}
      className="flex min-h-9 flex-wrap items-center gap-2 border-b border-border bg-warning/10 px-4 py-1 text-sm text-foreground"
    >
      <RefreshCwIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
      {skew === 'server' ? <RestartServer /> : <ReloadPage />}
    </div>
  )
}

function ReloadPage() {
  return (
    <>
      <span className="min-w-0">
        cezar was updated.<span className="text-muted-foreground"> This page is from the previous version.</span>
      </span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </>
  )
}

function RestartServer() {
  const status = useSelfUpdate()
  const schedule = useScheduleSelfUpdate()
  const data = status.data
  // The self-update service's own restart: re-applying the active install restarts into what is
  // on disk, and `whenIdle` holds it until no task is running or queued.
  const active = data?.canSelfUpdate ? data.installed.find((v) => v.active) : undefined
  const pending = schedule.isPending || !!data?.scheduled || data?.job?.status === 'restarting'
  const busy = (data?.activeRuns ?? 0) > 0
  return (
    <>
      <span className="min-w-0">
        cezar was updated, restart to finish.
        {active ? (
          pending ? (
            <span className="text-muted-foreground"> {busy ? 'Restarts when running tasks finish.' : 'Restarting…'}</span>
          ) : null
        ) : (
          <span className="text-muted-foreground">
            {inDesktopApp() ? ' Quit and reopen the app.' : <> Stop <code>cezar</code> and start it again.</>}
          </span>
        )}
        {schedule.error ? <span className="text-destructive"> {schedule.error.message}</span> : null}
      </span>
      {active && !pending ? (
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => schedule.mutate(active.id)}>
          {busy ? 'Restart when idle' : 'Restart'}
        </Button>
      ) : null}
    </>
  )
}
