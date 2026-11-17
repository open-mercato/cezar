import { expect, it } from 'vitest'
import { extensionRecordSchema } from '@open-mercato/cezar-contract'
import { projectInventory } from './inventory.ts'

const record = extensionRecordSchema.parse({ manifest: { id: 'probe', name: 'Probe', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] }, source: './probe', installedAt: 'now', integrity: 'sha512-AAAA', enabled: true })
const project = (failed: boolean, saved = record) => projectInventory({ installed: [record], saved: [saved], status: () => failed ? 'failed' : 'running', failed: () => failed })[0]!

it('offers enable for an enabled extension whose worker failed, so it can be retried', () => {
  expect(project(true)).toMatchObject({ availability: 'failed', record: { enabled: true, status: 'failed' }, management: { enable: true, disable: true } })
})

it('offers no enable for a healthy enabled extension', () => {
  expect(project(false)).toMatchObject({ availability: 'available', management: { enable: false, disable: true } })
})

it('offers enable for a disabled extension', () => {
  expect(project(false, { ...record, enabled: false })).toMatchObject({ availability: 'disabled', management: { enable: true, disable: false } })
})
