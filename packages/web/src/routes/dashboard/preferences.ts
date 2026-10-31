import { dashboardPreferencesSchema } from '@open-mercato/cezar-api-client'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { getWorkspaceUiState, putWorkspaceUiState } from '@/api/client'
export type Tiles = {
  automations: boolean
  fleet: boolean
  needsYou: boolean
  recent: boolean
  usage: boolean
  trends: boolean
}
export type TileId = keyof Tiles | 'overview' | 'portfolio'
export const defaultOrder: TileId[] = [
  'overview',
  'needsYou',
  'recent',
  'fleet',
  'automations',
  'portfolio',
  'usage',
  'trends',
]
const isKnownTile = (id: string): id is TileId => defaultOrder.includes(id as TileId)
export function normalizeOrder(saved: string[] = []): TileId[] {
  const order = saved.filter(isKnownTile)
  const legacyDefault = defaultOrder.filter((id) => id !== 'automations')
  const matches = (candidate: TileId[]) =>
    order.length === candidate.length && order.every((id, index) => id === candidate[index])
  // Upgrade the incomplete legacy default only. A complete sequence may be
  // intentional, including a user dragging Automations to the last position.
  if (matches(legacyDefault)) return [...defaultOrder]
  return [
    ...new Set([
      ...(order.includes('overview') ? [] : ['overview' as const]),
      ...order,
      ...defaultOrder,
    ]),
  ]
}
/** Only replace slots this client understands; future widgets stay in the stored order. */
function mergeOrder(saved: string[] = [], order: TileId[]): string[] {
  let index = 0
  const merged = saved.map((id) => (isKnownTile(id) ? order[index++]! : id))
  return [...merged, ...order.slice(index)]
}
type Layout = { tiles: Tiles; order: TileId[] }
export function useDashboardPreferences() {
  const query = useWorkspaceUiState()
  const client = useQueryClient()
  const [local, setLocal] = useState<Layout>()
  const [failed, setFailed] = useState(false)
  const pending = useRef<Layout | undefined>(undefined)
  const writing = useRef(false)
  const parsed = dashboardPreferencesSchema.parse(query.data?.dashboard ?? {})
  const bag = useRef(parsed)
  bag.current = parsed
  const tiles = local?.tiles ?? {
    automations: parsed.tiles?.automations ?? true,
    fleet: parsed.tiles?.fleet ?? true,
    needsYou: parsed.tiles?.needsYou ?? true,
    recent: parsed.tiles?.recent ?? true,
    usage: parsed.tiles?.usage ?? true,
    trends: parsed.tiles?.trends ?? true,
  }
  const order = normalizeOrder(local?.order ?? parsed.order)
  const current = useRef<Layout>({ tiles, order })
  current.current = local ?? { tiles, order }
  const update = (patch: Partial<Layout>) => {
    const next = { ...current.current, ...patch }
    current.current = next
    setLocal(next)
    pending.current = next
  }
  const flush = async () => {
    if (writing.current || !pending.current) return
    writing.current = true
    while (pending.current) {
      const next = pending.current
      pending.current = undefined
      try {
        if (!query.data)
          bag.current = dashboardPreferencesSchema.parse(
            (await getWorkspaceUiState()).dashboard ?? {},
          )
        const saved = await putWorkspaceUiState({
          dashboard: {
            ...bag.current,
            order: mergeOrder(bag.current.order, next.order),
            tiles: { ...bag.current?.tiles, ...next.tiles },
          },
        })
        client.setQueryData(workspaceQueryKeys.uiState, saved)
        bag.current = dashboardPreferencesSchema.parse(saved.dashboard ?? {})
        setFailed(false)
        setLocal((current) => (current === next ? undefined : current))
      } catch {
        setFailed(true)
        if (!pending.current) pending.current = next
        break
      }
    }
    writing.current = false
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(
    () => () => {
      void flushRef.current()
    },
    [],
  )
  useEffect(() => {
    if (!local) return
    const timer = setTimeout(() => {
      void flush()
    }, 250)
    return () => clearTimeout(timer)
  }, [local])
  return {
    tiles,
    order,
    setOrder: (order: TileId[]) => update({ order: normalizeOrder(order) }),
    failed,
    ready: query.data !== undefined || query.isError,
    setTiles(next: Tiles) {
      update({ tiles: next })
    },
    retry: () => {
      void flush()
    },
  }
}

/** Reset only this view's slots; preserve the other view's order and placement. */
export function resetViewOrder(order: TileId[], scope: TileId[]): TileId[] {
  const defaults = defaultOrder.filter((id) => scope.includes(id))
  let index = 0
  return order.map((id) => (scope.includes(id) ? defaults[index++]! : id))
}
