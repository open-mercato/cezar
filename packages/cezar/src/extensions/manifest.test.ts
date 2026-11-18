import { describe, expect, it } from 'vitest'
import { extensionManifestSchema } from '@open-mercato/cezar-contract'

const base = { id: 'example.test', name: 'Example', version: '0.1.0', apiVersion: '0.1' as const, entry: 'dist/index.js', capabilities: ['commands', 'panels'], permissions: [] }
describe('extension manifest', () => {
  it('rejects unsupported API versions', () => expect(extensionManifestSchema.safeParse({ ...base, apiVersion: '0.2' }).success).toBe(false))
  it('rejects absolute and escaping entry points', () => {
    expect(extensionManifestSchema.safeParse({ ...base, entry: '../main.js' }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...base, entry: '/tmp/main.js' }).success).toBe(false)
  })
  it('rejects duplicate command contributions', () => expect(extensionManifestSchema.safeParse({ ...base, contributes: { commands: [{ id: 'run', label: 'Run' }, { id: 'run', label: 'Run again' }], panels: [] } }).success).toBe(false))
  it('requires capabilities, so a consent card can name exactly what it approves', () => {
    const { capabilities: _, ...withoutCapabilities } = base
    expect(extensionManifestSchema.safeParse(withoutCapabilities).success).toBe(false)
  })
  it.each([{ main: 'dist/index.js' }, { schemaVersion: 1 }, { actions: [] }, { panels: [] }, { permissions: ['tasks.read'] }])('refuses the removed spelling %j', patch =>
    expect(extensionManifestSchema.safeParse({ ...base, ...patch }).success).toBe(false))
  it('bounds placements per extension and leaves a location-free manifest untouched', () => {
    const panels = (n: number, location: string) => Array.from({ length: n }, (_, i) => ({ id: `${location}${i}`, title: 'P', location }))
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { panels: panels(3, 'sidebar') } }).success).toBe(true)
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { panels: panels(4, 'sidebar') } }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { panels: panels(6, 'task') } }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { commands: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, label: 'C', location: 'palette' })) } }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { panels: [{ id: 'p', title: 'P', location: 'palette' }] } }).success).toBe(false)
    const parsed = extensionManifestSchema.parse({ ...base, contributes: { commands: [{ id: 'c', label: 'C' }], panels: [{ id: 'p', title: 'P' }] } })
    expect('location' in parsed.contributes!.commands[0]!).toBe(false)
    expect('location' in parsed.contributes!.panels[0]!).toBe(false)
  })
})
