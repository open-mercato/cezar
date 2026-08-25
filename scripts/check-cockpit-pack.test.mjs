import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  copyConsumerFixture,
  scanInstalledRuntime,
} from './check-cockpit-pack.mjs'

test('copyConsumerFixture copies only the public consumer fixture files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-copy-test-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })

  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await Promise.all([
    writeFile(path.join(source, 'package.json'), '{"private":true}\n'),
    writeFile(path.join(source, 'tsconfig.json'), '{}\n'),
    writeFile(path.join(source, 'vite.config.ts'), 'export default {}\n'),
    writeFile(path.join(source, 'src/main.tsx'), 'export {}\n'),
    writeFile(path.join(source, 'private-notes.txt'), 'must not be copied\n'),
  ])

  const copied = await copyConsumerFixture(source, destination)

  assert.deepEqual(copied, [
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'src/main.tsx',
  ])
  await assert.doesNotReject(() => readFile(path.join(destination, 'src/main.tsx'), 'utf8'))
  await assert.rejects(() => readFile(path.join(destination, 'private-notes.txt'), 'utf8'), {
    code: 'ENOENT',
  })
})

const forbiddenMarkers = [
  'packages/web',
  '@open-mercato/cezar-web',
  '#cezar-web-cockpit',
  'src/cockpit-implementation',
]

for (const marker of forbiddenMarkers) {
  test(`scanInstalledRuntime rejects private runtime marker ${marker}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-scan-test-'))
    t.after(async () => {
      await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
    })
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist/index.js'), `export const seam = ${JSON.stringify(marker)}\n`)

    await assert.rejects(() => scanInstalledRuntime(root), new RegExp(marker.replaceAll('/', '[/\\\\]')))
  })
}

test('scanInstalledRuntime scans declarations and JavaScript but ignores README prose', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-scan-test-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  await mkdir(path.join(root, 'dist'), { recursive: true })
  await Promise.all([
    writeFile(path.join(root, 'dist/index.js'), 'export const ready = true\n'),
    writeFile(path.join(root, 'dist/index.d.ts'), 'export declare const ready: true\n'),
    writeFile(path.join(root, 'README.md'), 'Historical packages/web prose is documentation.\n'),
  ])

  assert.deepEqual(await scanInstalledRuntime(root), {
    filesScanned: 2,
    forbiddenMatches: 0,
  })
})
