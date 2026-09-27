import { useSyncExternalStore } from 'react'
import type { DashboardTelemetrySample } from '@open-mercato/cezar-api-client'

export function createDashboardLiveStore(clock = () => performance.now()) {
  const entries = new Map<string, { sample: DashboardTelemetrySample; deadline: number }>()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let state: { connected: boolean; samples: DashboardTelemetrySample[] } = {
    connected: false,
    samples: [],
  }
  const emit = () => {
    state = { ...state, samples: [...entries.values()].map((e) => e.sample) }
    listeners.forEach((fn) => fn())
  }
  const expire = () => {
    let changed = false
    for (const [key, value] of entries)
      if (value.deadline <= clock()) {
        entries.delete(key)
        changed = true
      }
    if (changed) emit()
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      if (!timer) timer = setInterval(expire, 1000)
      expire()
      return () => {
        listeners.delete(fn)
        if (!listeners.size) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
    expire,
    connected(connected: boolean) {
      if (state.connected !== connected) {
        state = { ...state, connected }
        emit()
      }
    },
    replace(project: string, samples: DashboardTelemetrySample[], asOf?: string) {
      for (const [key, value] of entries)
        if (value.sample.projectId === project) entries.delete(key)
      const serverNow = asOf ? Date.parse(asOf) : NaN
      for (const sample of samples) {
        const age = Math.max(0, serverNow - Date.parse(sample.sampledAt))
        if (Number.isFinite(age) && age < 10_000 && sample.projectId === project)
          entries.set(`${project}:${sample.runId}`, { sample, deadline: clock() + 10_000 - age })
      }
      emit()
    },
    seed(samples: DashboardTelemetrySample[], asOf: string) {
      for (const [key, value] of entries)
        if (Date.parse(value.sample.sampledAt) <= Date.parse(asOf)) entries.delete(key)
      for (const sample of samples) {
        const age = Math.max(0, Date.parse(asOf) - Date.parse(sample.sampledAt))
        if (
          Number.isFinite(age) &&
          age < 10_000 &&
          !entries.has(`${sample.projectId}:${sample.runId}`)
        )
          entries.set(`${sample.projectId}:${sample.runId}`, {
            sample,
            deadline: clock() + 10_000 - age,
          })
      }
      emit()
    },
    remove(project: string, runId?: string) {
      for (const [key, value] of entries)
        if (value.sample.projectId === project && (!runId || value.sample.runId === runId))
          entries.delete(key)
      emit()
    },
  }
}
export const dashboardLive = createDashboardLiveStore()
export const useDashboardLive = () =>
  useSyncExternalStore(dashboardLive.subscribe, dashboardLive.getSnapshot)
