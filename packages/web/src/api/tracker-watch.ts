import { useEffect, useRef, useState } from 'react'
import { useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query'
import { queryScope, trackerWatchSignalSchema, type TrackerItemsResponse, type TrackerItemsSuccess, type TrackerWatchInput, type TrackerWatchSnapshot } from '@open-mercato/cezar-api-client'
import { openTrackerWatch, readTrackerWatch, refreshTrackerWatch } from './client'
import { useHealth, workspaceQueryKeys } from './queries'
import { subscribeTopic } from './ws'

type Pages = InfiniteData<TrackerItemsResponse, string | undefined>
const samePage = (a: TrackerItemsResponse | undefined, b: TrackerItemsSuccess) => a?.available && JSON.stringify([a.items, a.truncated]) === JSON.stringify([b.items, b.truncated])

/** View-owned demand; the server clock is shared across tabs. No browser vendor polling timer. */
export function useTrackerWatch(input: TrackerWatchInput, queryKey: QueryKey, enabled = true) {
  const client = useQueryClient()
  const health = useHealth()
  const project = queryScope()
  const identity = JSON.stringify([project, input, queryKey])
  const [view, setView] = useState<{ identity: string; snapshot: TrackerWatchSnapshot | null; error: string | null; pending: TrackerItemsSuccess | null }>({ identity, snapshot: null, error: null, pending: null })
  const actions = useRef({ refresh: async () => {}, applyChanges: async () => {} })
  const mode = health.data ? (health.data.capabilities.localHandoff ? 'local' : 'remote') : null

  useEffect(() => {
    setView({ identity, snapshot: null, error: null, pending: null })
    if (!mode || !enabled) return
    const key = queryKey
    let disposed = false
    let stop = () => {}
    let latest: TrackerWatchSnapshot | null = null
    let pending: TrackerItemsSuccess | null = null
    let applyAfterFetch: TrackerItemsSuccess | null = null
    const update = (error: string | null = null) => {
      if (!disposed) setView({ identity, snapshot: latest, error, pending })
    }
    const apply = (page: TrackerItemsSuccess, force = false) => {
      const current = client.getQueryData<Pages>(key)
      const fetching = client.getQueryState(key)?.fetchStatus === 'fetching'
      if (!force && ((current?.pages.length ?? 0) > 1 || fetching)) {
        if (fetching) applyAfterFetch = page
        pending = samePage(current?.pages[0], page) ? null : page
      } else {
        pending = null
        applyAfterFetch = null
        client.setQueryData<Pages>(key, { pages: [page], pageParams: [undefined] })
      }
    }
    const receive = (snapshot: TrackerWatchSnapshot) => {
      if (latest && snapshot.version < latest.version) return false
      const newSuccess = snapshot.result?.available && !snapshot.checking && snapshot.checkedAt !== latest?.checkedAt
      latest = snapshot
      if (newSuccess && snapshot.result?.available) apply(snapshot.result)
      if (snapshot.result && !snapshot.result.available && ['source_changed', 'credentials_missing', 'not_configured'].includes(snapshot.result.code)) {
        pending = null; applyAfterFetch = null
        // Connection events normally unmount this view. Also reconcile external file edits.
        void Promise.all([
          client.invalidateQueries({ queryKey: ['tracker', project, 'association'] }),
          client.invalidateQueries({ queryKey: ['tracker', project, 'connection'] }),
          client.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
        ])
      }
      update()
      return true
    }
    const uncache = client.getQueryCache().subscribe(event => {
      if (disposed || !applyAfterFetch || JSON.stringify(event.query.queryKey) !== JSON.stringify(key) || event.query.state.fetchStatus !== 'idle') return
      const page = applyAfterFetch
      applyAfterFetch = null
      apply(page)
      update()
    })
    const activate = () => {
      stop()
      actions.current = { refresh: async () => {}, applyChanges: async () => {} }
      if (disposed || document.visibilityState === 'hidden') return
      const abort = new AbortController()
      let offTopic = () => {}
      let retry: ReturnType<typeof setTimeout> | undefined
      let handle: Awaited<ReturnType<typeof openTrackerWatch>> | null = null
      let fetching = false
      let again = false
      const active = () => !disposed && !abort.signal.aborted
      stop = () => { abort.abort(); offTopic(); clearTimeout(retry) }
      const accept = (snapshot: TrackerWatchSnapshot) => active() && receive(snapshot)
      const fail = () => {
        if (!active()) return
        update('Automatic checking is temporarily unavailable. Retrying…')
        offTopic(); clearTimeout(retry)
        retry = setTimeout(() => { if (active()) activate() }, 5_000)
      }
      const pull = async () => {
        if (!active() || !handle) return
        if (fetching) { again = true; return }
        fetching = true
        try {
          do { again = false; accept(await readTrackerWatch(project, handle.id, abort.signal)) } while (again && active())
        } catch { fail() }
        finally { fetching = false }
      }
      actions.current = {
        refresh: async () => {
          if (!handle || !active()) return
          try {
            const snapshot = await refreshTrackerWatch(project, handle.id, abort.signal)
            if (!active() || (latest && snapshot.version < latest.version)) return
            await client.cancelQueries({ queryKey: key, exact: true })
            if (!active()) return
            if (!accept(snapshot)) return
            if (snapshot.result?.available) { apply(snapshot.result, true); update() }
          } catch { fail() }
        },
        applyChanges: async () => {
          if (!pending || !active()) return
          await client.cancelQueries({ queryKey: key, exact: true })
          if (active() && pending) { apply(pending, true); update() }
        },
      }
      void (async () => {
        try {
          handle = await openTrackerWatch(project, input, abort.signal)
          if (!active()) return
          // Version numbers are scoped to a handle; a newly registered watch starts at zero.
          latest = null
          if (mode === 'local') {
            offTopic = subscribeTopic(handle.topic, data => {
              if (trackerWatchSignalSchema.safeParse(data).success) void pull()
            }, fail)
            await pull()
          } else {
            let version = -1
            while (active()) {
              const snapshot = await readTrackerWatch(project, handle.id, abort.signal, Math.max(0, version))
              accept(snapshot)
              version = snapshot.version
              if (snapshot.result && !snapshot.result.available && snapshot.result.code === 'source_changed') break
            }
          }
        } catch { fail() }
      })()
    }
    activate()
    document.addEventListener('visibilitychange', activate)
    return () => { disposed = true; stop(); uncache(); document.removeEventListener('visibilitychange', activate) }
    // Values are encoded in identity so equal filter arrays do not recreate demand on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, identity, mode, enabled])

  const current = view.identity === identity ? view : null
  const snapshot = current?.snapshot
  return {
    ready: snapshot != null,
    checkedAt: snapshot?.checkedAt ?? null,
    checking: snapshot?.checking ?? false,
    error: current?.error ?? (snapshot?.result && !snapshot.result.available ? snapshot.result.reason : null),
    hasChanges: !!current?.pending,
    refresh: () => actions.current.refresh(),
    applyChanges: () => actions.current.applyChanges(),
  }
}
