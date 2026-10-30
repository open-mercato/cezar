import { describe, expect, it } from 'vitest'
import type { RunnerModelCatalogResponse } from '@open-mercato/cezar-api-client'
import { accessModeError, availableAccessModes, catalogAccount, modelForAccessMode, modelsForAccessMode, selectedAccessMode } from './access-mode'

const catalog: RunnerModelCatalogResponse = { runner: 'codex', source: 'live', stale: false, models: [
  { id: 'a', label: 'A', description: '', supportedAccessModes: ['standard', 'daybreak-blue'] },
  { id: 'b', label: 'B', description: '', supportedAccessModes: ['daybreak-blue'] },
  { id: 'daybreak-latest', label: 'Alias', description: '' },
  { id: 'standard', label: 'Standard', description: '', supportedAccessModes: ['standard'] },
] }

describe('independent access/model compatibility', () => {
  it('offers only advertised programs, while unknown catalogs grant nothing', () => {
    expect(availableAccessModes(catalog)).toEqual(['standard', 'daybreak-blue'])
    expect(availableAccessModes()).toEqual([])
    expect(availableAccessModes({} as RunnerModelCatalogResponse)).toEqual([])
    expect(accessModeError('daybreak-blue', 'a', {} as RunnerModelCatalogResponse)).toBeDefined()
    expect(availableAccessModes({ ...catalog, models: [catalog.models[2]!] })).toEqual([])
  })
  it('keeps either eligible underlying model when changing mode', () => {
    expect(modelForAccessMode('a', 'daybreak-blue', catalog)).toBe('a')
    expect(modelForAccessMode('b', 'daybreak-blue', catalog)).toBe('b')
    expect(modelForAccessMode('standard', 'daybreak-blue', catalog)).toBe('a')
    expect(modelForAccessMode('daybreak-latest', null, catalog)).toBe('daybreak-latest')
  })
  it('does not infer eligibility from aliases or auto and preserves an invalid pick for correction', () => {
    expect(accessModeError('daybreak-blue', 'daybreak-latest', catalog)).toContain('does not advertise')
    expect(accessModeError('daybreak-blue', '', catalog)).toBeDefined()
    expect(accessModeError('daybreak-blue', 'a')).toBeDefined()
    expect(accessModeError(null, 'custom-model')).toBeUndefined()
    expect(modelsForAccessMode(catalog.models, 'daybreak-blue', 'a', catalog).map((model) => model.id)).toEqual(['a', 'b'])
  })
  it('retains native behavior for other backends and locked native settings', () => {
    expect(selectedAccessMode('codex', 'standard')).toBe('standard')
    expect(selectedAccessMode('codex', null)).toBeUndefined()
    expect(selectedAccessMode('claude', 'daybreak-blue')).toBeUndefined()
    expect(selectedAccessMode('codex', 'daybreak-blue', true)).toBeUndefined()
    expect(catalogAccount('codex', 'work')).toBe('work')
    expect(catalogAccount('codex', 'default')).toBeUndefined()
    expect(catalogAccount('claude', 'work')).toBeUndefined()
  })
})
