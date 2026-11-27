import type { AgentProviderEntry, RunnerModelCatalogResponse } from '@open-mercato/cezar-api-client'
import type { ModelPreset } from './new-task-form'

/** Two providers can serve the same model ID. Only the picker value includes the method. */
export function composerModelOptions(models: readonly ModelPreset[], catalog?: RunnerModelCatalogResponse, entry?: AgentProviderEntry) {
  const offered = new Set(models.map(model => model.id))
  const rows: ModelPreset[] = []
  const listed = new Set<string>()
  for (const model of catalog?.models ?? []) {
    if (!offered.has(model.id) || !model.id) continue
    const key = JSON.stringify([model.id, model.via?.methodId])
    if (listed.has(key)) continue
    listed.add(key)
    rows.push({ id: model.id, label: model.label || model.id, desc: model.description, via: model.via })
  }
  const ids = new Set(rows.map(row => row.id))
  const choices = [...models.filter(model => !model.id), ...rows, ...models.filter(model => model.id && !ids.has(model.id))]
  const active = entry?.mode === 'one' && entry.methods.find(method => method.id === entry.active && method.state === 'connected')
  const order = new Map(entry?.methods.map((m, i) => [m.id, i]))
  if (entry?.mode === 'any') choices.sort((a, b) => (order.get(a.via?.methodId ?? '') ?? -1) - (order.get(b.via?.methodId ?? '') ?? -1))
  return choices.map(model => {
    const via = model.via?.label ?? (active ? active.label : undefined)
    return {
      model: model.id,
      method: model.via?.methodId,
      value: model.via ? JSON.stringify([model.via.methodId, model.id]) : model.id,
      label: model.label,
      desc: [via && `via ${via}`, model.desc].filter(Boolean).join(' · '),
      group: entry?.mode === 'any' ? model.via?.label : undefined,
    }
  })
}
