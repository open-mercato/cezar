import { useQuery } from '@tanstack/react-query'
import type {
  CreateLlmProvider,
  LlmProvidersResponse,
  Runner,
  RunnerModelCatalogResponse,
} from '@open-mercato/cezar-api-client'
import {
  addLlmProvider,
  deleteLlmProvider,
  getLlmProviders,
  getLlmProviderModels,
} from './client'

export { addLlmProvider, deleteLlmProvider }
export type { CreateLlmProvider }
export const llmProvidersKey = ['workspace', 'llm-providers'] as const
export function useLlmProviders() {
  return useQuery<LlmProvidersResponse>({
    queryKey: llmProvidersKey,
    queryFn: () => getLlmProviders(),
  })
}
export function useLlmProviderModels(runner: Runner, id: string | undefined) {
  return useQuery<RunnerModelCatalogResponse>({
    queryKey: [...llmProvidersKey, id, runner],
    queryFn: () => getLlmProviderModels(runner, id!),
    enabled: !!id,
    staleTime: 300_000,
  })
}
