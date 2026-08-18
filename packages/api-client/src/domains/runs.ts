import {
  apiRunSchema,
  archiveFinishedResponseSchema,
  markAllReadResponseSchema,
  runHistoryContextSchema,
  runHistoryPageSchema,
  runRecordSchema,
  type ApiRun,
  type ArchiveFinishedResponse,
  type MarkAllReadResponse,
  type PatchRunInput,
  type RunHistoryContext,
  type RunHistoryPage,
  type RunRecord,
} from '@open-mercato/cezar-contract'

import { projectApiPath } from '../utils/urls.ts'

export interface ReadOptions {
  signal?: AbortSignal
}

export interface CezarRunsDomain {
  list(options?: ReadOptions): Promise<ApiRun[]>
  get(runId: string, options?: ReadOptions): Promise<ApiRun>
  history(runId: string, cursor?: string, options?: ReadOptions): Promise<RunHistoryPage>
  historyContext(runId: string, options?: ReadOptions): Promise<RunHistoryContext>
  archiveFinished(): Promise<ArchiveFinishedResponse>
  markAllSeen(): Promise<MarkAllReadResponse>
  markSeen(runId: string): Promise<RunRecord>
  markUnseen(runId: string): Promise<RunRecord>
  update(runId: string, patch: PatchRunInput): Promise<RunRecord>
}

type JsonSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

type RequestJson = <T>(schema: JsonSchema<T>, path: string, init?: RequestInit) => Promise<T>

export function createCezarRunsDomain(projectId: string | null, requestJson: RequestJson): CezarRunsDomain {
  const path = (suffix: `/${string}`) => projectApiPath(projectId, suffix)
  const runPath = (runId: string, suffix = '') => path(`/runs/${encodeURIComponent(runId)}${suffix}`)
  const read = (options?: ReadOptions): RequestInit => ({ method: 'GET', signal: options?.signal })

  return {
    list: (options) => requestJson(apiRunSchema.array(), path('/runs'), read(options)),
    get: (runId, options) => requestJson(apiRunSchema, runPath(runId), read(options)),
    history: (runId, cursor, options) => {
      const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor }).toString()}`
      return requestJson(runHistoryPageSchema, runPath(runId, `/history${query}`), read(options))
    },
    historyContext: (runId, options) =>
      requestJson(runHistoryContextSchema, runPath(runId, '/history-context'), read(options)),
    archiveFinished: () =>
      requestJson(archiveFinishedResponseSchema, path('/runs/archive-finished'), { method: 'POST' }),
    markAllSeen: () => requestJson(markAllReadResponseSchema, path('/runs/read-all'), { method: 'POST' }),
    markSeen: (runId) => requestJson(runRecordSchema, runPath(runId, '/read'), { method: 'POST' }),
    markUnseen: (runId) => requestJson(runRecordSchema, runPath(runId, '/unread'), { method: 'POST' }),
    update: (runId, patch) =>
      requestJson(runRecordSchema, runPath(runId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
  }
}
