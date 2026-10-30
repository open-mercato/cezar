import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { queryScope, type UiState } from '@open-mercato/cezar-api-client'

import { putUiState } from '@/api/client'
import { useUiState } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import { normalizeAutomationOrder, type AutomationOrder, type AutomationSort } from './automation-order'

type ProjectWrites = { sequence: number; chain: Promise<void> }
// A save must remain serialized after leaving this view and mounting it again.
const writeQueues = new WeakMap<QueryClient, Map<string, ProjectWrites>>()

export function useAutomationOrder() {
  const queryClient = useQueryClient()
  const uiState = useUiState()
  const scope = queryScope()
  const key = useMemo(() => [scope, 'ui-state'] as const, [scope])
  const preferences = normalizeAutomationOrder(uiState.data?.automationList)

  const write = (patch: Partial<AutomationOrder>) => {
    const current = queryClient.getQueryData<UiState>(key)
    if (current === undefined) return
    const raw = current.automationList
    const siblings = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const automationList = { ...siblings, ...normalizeAutomationOrder(raw), ...patch }
    queryClient.setQueryData<UiState>(key, { ...current, automationList })
    let projects = writeQueues.get(queryClient)
    if (projects === undefined) {
      projects = new Map()
      writeQueues.set(queryClient, projects)
    }
    let state = projects.get(scope)
    if (state === undefined) {
      state = { sequence: 0, chain: Promise.resolve() }
      projects.set(scope, state)
    }
    const sequence = ++state.sequence
    const projectWrites = state
    // Scope is captured here, before a queued write can outlive a project switch.
    const pending = state.chain.then(async () => {
      const merged = await putUiState({ automationList }, scope)
      if (sequence === projectWrites.sequence) queryClient.setQueryData<UiState>(key, merged)
    })
    state.chain = pending.catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      if (sequence === projectWrites.sequence) void queryClient.invalidateQueries({ queryKey: key })
    })
  }

  return {
    preferences,
    canSave: uiState.data !== undefined,
    setSort: (sort: AutomationSort) => write({ sort }),
    setOrder: (order: readonly string[]) => write({ order: normalizeAutomationOrder({ order }).order }),
  }
}
