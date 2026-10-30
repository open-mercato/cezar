import type { ExecutionAccessMode, Runner, RunnerModelCatalogResponse } from '@open-mercato/cezar-api-client'

export type AccessModePick = ExecutionAccessMode | null | undefined

export function selectedAccessMode(runner: Runner, pick: AccessModePick, locked = false): ExecutionAccessMode | undefined {
  return runner === 'codex' && !locked ? pick ?? undefined : undefined
}

export function accessModeError(mode: AccessModePick, model: string, catalog?: RunnerModelCatalogResponse): string | undefined {
  if (!mode || catalog?.models.find((option) => option.id === model)?.supportedAccessModes?.includes(mode)) return undefined
  return 'This account/model does not advertise the selected access mode. Choose an available model or Native default.'
}

export function availableAccessModes(catalog?: RunnerModelCatalogResponse): ExecutionAccessMode[] {
  return (['standard', 'daybreak-blue'] as const).filter((mode) =>
    catalog?.models.some((model) => model.supportedAccessModes?.includes(mode)),
  )
}

export function modelForAccessMode(model: string, mode: AccessModePick, catalog?: RunnerModelCatalogResponse): string {
  if (!mode || catalog?.models.find((option) => option.id === model)?.supportedAccessModes?.includes(mode)) return model
  return catalog?.models.find((option) => option.supportedAccessModes?.includes(mode))?.id ?? model
}

export function modelsForAccessMode<T extends { id: string }>(models: readonly T[], mode: AccessModePick, current: string, catalog?: RunnerModelCatalogResponse): readonly T[] {
  if (!mode) return models
  return models.filter((option) => option.id === current || catalog?.models.find((entry) => entry.id === option.id)?.supportedAccessModes?.includes(mode))
}

/** Default account retains the old cache key and request shape; other logins are isolated. */
export function catalogAccount(runner: Runner, account?: string | null): string | undefined {
  return runner === 'codex' && account && account !== 'default' ? account : undefined
}
