import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryScope, type LifecycleActionInput } from '@open-mercato/cezar-api-client'
import { useProjectScope } from './project-scope-context'
import { actOnLifecycleOperation, getLifecycleOperation, getLifecycleOutput, getWorktreeLifecycle, getWorktreeLifecycleDetail } from './client'

export const lifecycleQueryKeys = {
  all: (scope = queryScope()) => ['worktree-lifecycle', scope] as const,
  list: (scope = queryScope()) => [...lifecycleQueryKeys.all(scope), 'list'] as const,
  detail: (id: string, scope = queryScope()) => [...lifecycleQueryKeys.all(scope), 'worktree', id] as const,
  operation: (id: string, scope = queryScope()) => [...lifecycleQueryKeys.all(scope), 'operation', id] as const,
  output: (id: string, scope = queryScope()) => [...lifecycleQueryKeys.all(scope), 'output', id] as const,
}

/** The existing workspace SSE stream invalidates these only while a view observes them. */
export function useWorktreeLifecycles() {
  useProjectScope()
  return useQuery({ queryKey: lifecycleQueryKeys.list(), queryFn: async ({signal}) => {
    const first = await getWorktreeLifecycle({limit: 100}, {signal})
    const records = new Map(first.worktrees.map(record => [record.worktreeId, record]))
    const seen = new Set<string>()
    let cursor = first.nextCursor
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const page = await getWorktreeLifecycle({limit: 100, cursor}, {signal})
      for (const record of page.worktrees) records.set(record.worktreeId, record)
      cursor = page.nextCursor
    }
    return {worktrees: [...records.values()]}
  } })
}
export function useWorktreeLifecycleDetail(id: string, enabled = true) {
  useProjectScope()
  return useQuery({queryKey: lifecycleQueryKeys.detail(id), enabled, queryFn: ({signal}) => getWorktreeLifecycleDetail(id, {signal})})
}
export function useLifecycleOperation(id: string) {
  useProjectScope()
  return useQuery({queryKey: lifecycleQueryKeys.operation(id), queryFn: ({signal}) => getLifecycleOperation(id, {signal})})
}
export function useLifecycleOutput(id: string, enabled: boolean) {
  useProjectScope()
  return useInfiniteQuery({
    queryKey: lifecycleQueryKeys.output(id), enabled, initialPageParam: 0,
    queryFn: ({signal, pageParam}) => getLifecycleOutput(id, pageParam, {signal}),
    getNextPageParam: page => page.items.length >= 100 ? page.nextSeq : undefined,
    maxPages: 5,
  })
}
export function useLifecycleAction(id: string) {
  const queryClient = useQueryClient()
  useProjectScope()
  const scope = queryScope()
  return useMutation({
    mutationFn: (input: LifecycleActionInput) => actOnLifecycleOperation(id, input),
    onSuccess: response => {
      queryClient.setQueryData(lifecycleQueryKeys.operation(id, scope), response)
      void queryClient.invalidateQueries({queryKey: lifecycleQueryKeys.all(scope)})
      void queryClient.invalidateQueries({queryKey: ['runs', scope]})
      void queryClient.invalidateQueries({queryKey: ['worktrees', scope]})
    },
    onError: () => { void queryClient.invalidateQueries({queryKey: lifecycleQueryKeys.operation(id, scope)}) },
  })
}
