import { useMutation, useQueryClient } from '@tanstack/react-query'

import { cancelFleetJob } from '@/api/client'
import { useFleetPanel, workspaceQueryKeys } from '@/api/queries'
import type { FleetJob, FleetNode, FleetPanel } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

/** A node silent for longer than this is stale (the hub's own liveness window). */
const NODE_STALE_MS = 30_000
const CANCELLABLE = new Set<FleetJob['status']>(['pending', 'assigned', 'running', 'review'])

/** Pure so the tests (and the panel) agree on what "stale" means. */
export function isNodeStale(node: Pick<FleetNode, 'lastSeen'>, now = Date.now()): boolean {
  return now - Date.parse(node.lastSeen) > NODE_STALE_MS
}

/**
 * Global settings → Fleet (spec 2026-10-21-fleet-coordination): the nodes of this cezar's fleet and
 * its jobs, with a cancel button. Read-only otherwise; submitting stays with `cezar fleet submit`.
 * Only listed in the nav when the fleet is enabled (the registry gate), and refreshed every few
 * seconds while open. On a worker the numbers come from the hub, fetched by the cezar server.
 */
export function FleetSection() {
  const panel = useFleetPanel(true)
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: (id: string) => cancelFleetJob(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.fleet }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (panel.isPending) {
    return <p data-slot="fleet-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">Loading fleet…</p>
  }
  const data: FleetPanel | undefined = panel.data
  if (!data?.enabled) {
    return (
      <p data-slot="fleet-disabled" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Fleet coordination is off. Set <code className="font-mono text-[12px]">CEZ_FLEET_HUB=1</code> or{' '}
        <code className="font-mono text-[12px]">CEZ_FLEET_HUB_URL</code> to join one.
      </p>
    )
  }
  return (
    <div data-slot="fleet-section" className="mx-auto flex w-full max-w-4xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
      <p className="text-[13px] text-muted-foreground">
        This cezar is the fleet <strong>{data.role}</strong> <span className="font-mono text-[12px]">{data.nodeId}</span>.
        Queue work with <code className="font-mono text-[12px]">cezar fleet submit</code>.
      </p>
      {data.error ? (
        <p data-slot="fleet-error" role="alert" className="text-[13px] text-destructive">Could not reach the hub: {data.error}</p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">Nodes</h2>
        {data.nodes.length === 0 ? (
          <p data-slot="fleet-no-nodes" className="text-[13px] text-soft-foreground">No nodes have checked in.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {data.nodes.map((node) => (
              <li key={node.nodeId} data-slot="fleet-node" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[13px]">
                <span className="font-mono">{node.nodeId}</span>
                <span>{node.capacity.free}/{node.capacity.max} free</span>
                {node.host.cpuPct !== undefined ? <span className="text-muted-foreground">cpu {node.host.cpuPct}%</span> : null}
                <span className="text-muted-foreground">v{node.version}</span>
                {isNodeStale(node) ? <span data-slot="fleet-node-stale" className="text-destructive">stale</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">Jobs</h2>
        {data.jobs.length === 0 ? (
          <p data-slot="fleet-no-jobs" className="text-[13px] text-soft-foreground">No jobs yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {data.jobs.map((job) => (
              <li key={job.id} data-slot="fleet-job" className="flex flex-col gap-1 px-3 py-2 text-[13px]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span data-slot="fleet-job-status" className="font-medium">{job.status}</span>
                  {job.nodeId ? <span className="font-mono text-muted-foreground">@{job.nodeId}</span> : null}
                  <span className="min-w-0 flex-1 truncate" title={job.task}>{job.task}</span>
                  {CANCELLABLE.has(job.status) ? (
                    <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-3 text-muted-foreground">
                  <span className="font-mono text-[12px]">{job.repoUrl}</span>
                  {job.branch ? <span className="font-mono text-[12px]">{job.branch}</span> : null}
                  {job.prUrl ? <a className="underline" href={job.prUrl} target="_blank" rel="noreferrer">PR</a> : null}
                  {job.branchUrl ? <a className="underline" href={job.branchUrl} target="_blank" rel="noreferrer">branch</a> : null}
                </div>
                {job.error ? <p data-slot="fleet-job-error" className="text-destructive">{job.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
