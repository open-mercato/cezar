import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionRecordSchema } from '@open-mercato/cezar-contract'
import { ExtensionStore } from './store.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function record(id: string) { return extensionRecordSchema.parse({ manifest: { id, name: id, version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] }, source: id, installedAt: 'now', enabled: false }) }
it('loadsValidRecordsBesideCorruptOne', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-store-')); roots.push(root)
  const file = join(root, 'registry.json')
  await writeFile(file, JSON.stringify([record('first'), { bad: true }, record('last')]))
  expect((await new ExtensionStore(file).list()).map(r => r.manifest.id)).toEqual(['first', 'last'])
})
it('retains corrupt records when updating valid records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-store-')); roots.push(root)
  const file = join(root, 'registry.json')
  const corrupt = { bad: true }
  await writeFile(file, JSON.stringify([record('first'), corrupt]))
  await new ExtensionStore(file).update(records => [...records, record('last')])
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([record('first'), record('last'), corrupt])
})
it('serializes concurrent read-modify-write across independent store instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-store-')); roots.push(root)
  const file = join(root, 'registry.json')
  await Promise.all(Array.from({ length: 20 }, (_, i) => new ExtensionStore(file).update(records => [...records, record(`item-${i}`)])))
  expect(await new ExtensionStore(file).list()).toHaveLength(20)
  expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(20)
  await expect(new ExtensionStore(file).update(() => { throw new Error('failed') })).rejects.toThrow('failed')
  expect(await new ExtensionStore(file).list()).toHaveLength(20)
})

it('serializes writes from separate Node processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-store-')); roots.push(root)
  const file = join(root, 'registry.json')
  const moduleUrl = new URL('./store.ts', import.meta.url).href
  await Promise.all(Array.from({ length: 4 }, (_, i) => promisify(execFile)(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    `import { ExtensionStore } from ${JSON.stringify(moduleUrl)}; const store = new ExtensionStore(${JSON.stringify(file)}); for (let n=0;n<5;n++) await store.update(records => [...records, {...${JSON.stringify(record(`child-${i}`))}, source: String(n)}]);`,
  ], { timeout: 30_000 })))
  expect(await new ExtensionStore(file).list()).toHaveLength(20)
}, 40_000)
