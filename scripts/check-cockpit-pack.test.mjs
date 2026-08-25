import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertCssUrlsResolve,
  countEmbeddedCssFonts,
  copyConsumerFixture,
  scanInstalledRuntime,
  withTemporaryPackageRoot,
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

test('assertCssUrlsResolve accepts carried assets and rejects escaped or missing local URLs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-css-test-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  const css = path.join(root, 'dist/styles.css')
  const font = path.join(root, 'dist/assets/font.woff2')
  await mkdir(path.dirname(font), { recursive: true })
  await writeFile(font, 'font bytes')
  await writeFile(css, '@font-face{src:url(./assets/font.woff2)}')

  assert.deepEqual(await assertCssUrlsResolve(css, root), [font])

  await writeFile(css, '@font-face{src:url(/assets/font.woff2)}')
  await assert.rejects(() => assertCssUrlsResolve(css, root), /escapes .* package root/)

  await writeFile(css, '@font-face{src:url(.\/assets\/missing.woff2)}')
  await assert.rejects(() => assertCssUrlsResolve(css, root), /missing local CSS asset/)
})

test('countEmbeddedCssFonts counts font payloads resolved into consumer CSS', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-font-test-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  const css = path.join(root, 'consumer.css')
  await writeFile(css, [
    '@font-face{src:url(data:font/woff2;base64,Zm9udDE=)}',
    '@font-face{src:url("data:font/woff2;base64,Zm9udDI=")}',
    '.external{background:url(https://example.test/image.png)}',
  ].join(''))

  assert.equal(await countEmbeddedCssFonts(css), 2)
})

test('withTemporaryPackageRoot keeps the npm cache unique and removes it with the root', async () => {
  let observedRoot
  let observedCache
  let failedRoot

  await withTemporaryPackageRoot(async ({ temporaryRoot, npmCache }) => {
    observedRoot = temporaryRoot
    observedCache = npmCache
    assert.equal(path.dirname(npmCache), temporaryRoot)
    await mkdir(npmCache, { recursive: true })
    await writeFile(path.join(npmCache, 'marker'), 'isolated')
  })

  await assert.rejects(() => access(observedCache), { code: 'ENOENT' })
  await assert.rejects(() => access(observedRoot), { code: 'ENOENT' })

  await assert.rejects(
    () => withTemporaryPackageRoot(async ({ temporaryRoot, npmCache }) => {
      failedRoot = temporaryRoot
      await mkdir(npmCache, { recursive: true })
      throw new Error('fixture failure')
    }),
    /fixture failure/,
  )
  await assert.rejects(() => access(failedRoot), { code: 'ENOENT' })
})
