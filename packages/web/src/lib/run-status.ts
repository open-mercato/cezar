import type { RunStatus } from '@open-mercato/cezar-api-client'

/** "Active" in the legacy sense: the engine still owns the run (a queued run is parked but
 *  claimed). `review` is deliberately NOT active — a parked review can be continued, archived
 *  or deleted like any finished run. */
export function isRunActive(status: RunStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'waiting'
}
