import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ApiRun, CreateTaskTagInput, PatchTaskTagInput, RunTag, RunsIndexResponse, TaskTagsList } from '@open-mercato/cezar-api-client'

import { createTaskTag, deleteTaskTag, editRunTags, getTaskTags, updateTaskTag } from '@/api/client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { applyTagDelta } from '@/lib/task-tags'

/** Task tags (spec 2026-11-23-task-tags § 7): one registry query, invalidated by every mutation. */
export const taskTagsQueryKey = ['workspace', 'task-tags'] as const

export function useTaskTags() {
  return useQuery({
    queryKey: taskTagsQueryKey,
    queryFn: ({ signal }) => getTaskTags({ signal }),
    staleTime: 30_000,
  })
}

function useTagMutation<TVariables, TResult>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskTagsQueryKey }),
  })
}

export function useCreateTaskTag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTaskTagInput) => createTaskTag(input),
    retry: false,
    // Land it in the cache at once so the picker can show the new row checked before the refetch.
    onSuccess: ({ tag }) => {
      queryClient.setQueryData<TaskTagsList>(taskTagsQueryKey, (current) =>
        current === undefined ? current : { ...current, tags: [...current.tags.filter((t) => t.id !== tag.id), tag] },
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskTagsQueryKey }),
  })
}

export function useUpdateTaskTag() {
  return useTagMutation((variables: { tagId: string } & PatchTaskTagInput) => {
    const { tagId, ...patch } = variables
    return updateTaskTag(tagId, patch)
  })
}

export function useDeleteTaskTag() {
  return useTagMutation((tagId: string) => deleteTaskTag(tagId))
}

export interface RunTagEdit {
  runId: string
  /** Snapshots of the tags to add — the picker already holds them, so the edit can be optimistic. */
  add?: RunTag[]
  remove?: string[]
}

type Snapshot = Array<[readonly unknown[], unknown]>

/** Patch one run's tags in every cache that holds it: the scoped detail and list, and the index. */
function patchRunTags(queryClient: QueryClient, runId: string, next: (current: RunTag[] | undefined) => RunTag[]): Snapshot {
  const saved: Snapshot = []
  const withTags = <T extends { id: string; tags?: RunTag[] }>(run: T): T => {
    if (run.id !== runId) return run
    const tags = next(run.tags)
    const { tags: _old, ...rest } = run
    return (tags.length > 0 ? { ...rest, tags } : rest) as T
  }
  for (const [key, data] of queryClient.getQueriesData<ApiRun | ApiRun[]>({ queryKey: queryKeys.runs.all })) {
    if (data === undefined) continue
    if (Array.isArray(data)) {
      if (!data.some((run) => run?.id === runId)) continue
      saved.push([key, data])
      queryClient.setQueryData(key, data.map(withTags))
    } else if (typeof data === 'object' && data !== null && (data as ApiRun).id === runId && 'status' in data) {
      saved.push([key, data])
      queryClient.setQueryData(key, withTags(data))
    }
  }
  const index = queryClient.getQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex)
  if (index?.runs.some((run) => run.id === runId)) {
    saved.push([workspaceQueryKeys.runsIndex, index])
    queryClient.setQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex, { ...index, runs: index.runs.map(withTags) })
  }
  return saved
}

/**
 * One run's tag delta, optimistic (spec § 7, the `useUpdateProject` fix built in): applied to the
 * caches on mutate, replaced by the server's list on success, rolled back on error.
 */
export function useEditRunTags() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, add, remove }: RunTagEdit) =>
      editRunTags(runId, {
        ...(add && add.length > 0 ? { add: add.map((tag) => ({ id: tag.id })) } : {}),
        ...(remove && remove.length > 0 ? { remove } : {}),
      }),
    retry: false,
    onMutate: ({ runId, add = [], remove = [] }) => ({
      saved: patchRunTags(queryClient, runId, (current) => applyTagDelta(current, add, remove)),
    }),
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.saved ?? []) queryClient.setQueryData(key, data)
    },
    onSuccess: ({ tags }, { runId }) => {
      patchRunTags(queryClient, runId, () => tags)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskTagsQueryKey }),
  })
}
