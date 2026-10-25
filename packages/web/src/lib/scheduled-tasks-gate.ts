import { useEffect, useSyncExternalStore } from 'react'
import { queryScope } from '@open-mercato/cezar-api-client'
import { onWorkspaceEvent } from '@/api/global-events'
import { useActiveProjectId } from '@/lib/project-router'
import { useAutomationsGate, useAutomationsQuery } from '@/routes/automations/use-automations'

/**
 * Whether the task lists should ask `GET /automations` for scheduled tasks (#1340). Each project
 * is asked once per cockpit session — a schedule made from any browser or the CLI still shows —
 * and asked again only after the composer schedules or an `automation-change` arrives.
 */
const settledEmpty = new Map<string, number>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function markScheduledTasks(scope = queryScope()) {
  settledEmpty.delete(scope)
  notify()
}

/** Tests only: forget what this session learned. */
export function resetScheduledTasksGate() {
  settledEmpty.clear()
  notify()
}

export function useScheduledTasksGate(): boolean {
  const gate = useAutomationsGate()
  const projectId = useActiveProjectId()
  const scope = projectId ?? queryScope()
  const empty = useSyncExternalStore(subscribe, () => settledEmpty.has(scope))
  // Disabled: reads whatever the lists fetched, never asks itself.
  const cached = useAutomationsQuery(false)
  const scheduled = cached.data?.automations.some((entry) => entry.deferredStart) ?? false
  useEffect(() => onWorkspaceEvent((name, payload) => {
    const changed = payload as { project?: unknown }
    if (name === 'automation-change' && (projectId === null || changed.project === projectId)) markScheduledTasks(scope)
  }), [projectId, scope])
  useEffect(() => {
    if (cached.data && !scheduled && !settledEmpty.has(scope)) { settledEmpty.set(scope, cached.dataUpdatedAt); notify() }
  }, [cached.data, cached.dataUpdatedAt, scheduled, scope])
  return gate.known && !gate.off && (!empty || scheduled)
}
