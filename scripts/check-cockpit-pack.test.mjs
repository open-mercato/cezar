import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertConsumerFontsMatch,
  assertCssUrlsResolve,
  assertReactTarball,
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

test('assertConsumerFontsMatch identifies emitted and embedded fonts by content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-font-test-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  const installedOne = path.join(root, 'installed-one.woff2')
  const installedTwo = path.join(root, 'installed-two.woff2')
  const emittedOne = path.join(root, 'emitted-one.woff2')
  const css = path.join(root, 'consumer.css')
  await Promise.all([
    writeFile(installedOne, 'font1'),
    writeFile(installedTwo, 'font2'),
    writeFile(emittedOne, 'font1'),
  ])
  await writeFile(css, [
    '@font-face{src:url("data:font/woff2;base64,Zm9udDI=")}',
    '.external{background:url(https://example.test/image.png)}',
  ].join(''))

  assert.equal(
    await assertConsumerFontsMatch([installedOne, installedTwo], [emittedOne], [css]),
    2,
  )
})

test('assertConsumerFontsMatch preserves binary bytes in percent-encoded data fonts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-percent-font-test-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  const installed = path.join(root, 'installed.woff2')
  const css = path.join(root, 'consumer.css')
  await writeFile(installed, Buffer.from([0x00, 0x7f, 0x80, 0xff]))
  await writeFile(css, '@font-face{src:url(data:font/woff2,%00%7F%80%FF)}')

  await assert.doesNotReject(async () => {
    assert.equal(await assertConsumerFontsMatch([installed], [], [css]), 1)
  })
})

test('assertConsumerFontsMatch rejects repeated and foreign payloads when installed fonts are missing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-font-identity-test-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  const installedFonts = await Promise.all(
    ['installed-one', 'installed-two', 'installed-three', 'installed-four'].map(async (contents, index) => {
      const font = path.join(root, `installed-${index + 1}.woff2`)
      await writeFile(font, contents)
      return font
    }),
  )
  const repeated = Buffer.from('installed-one').toString('base64')
  const foreign = Buffer.from('foreign-font').toString('base64')
  const css = path.join(root, 'consumer.css')
  await writeFile(css, [
    ...Array.from({ length: 4 }, () => `@font-face{src:url(data:font/woff2;base64,${repeated})}`),
    `@font-face{src:url(data:font/woff2;base64,${foreign})}`,
  ].join(''))

  await assert.rejects(
    () => assertConsumerFontsMatch(installedFonts, [], [css]),
    /consumer build is missing 3 of 4 installed fonts/,
  )
})

test('the React tarball gate requires both bundled font notices', () => {
  const complete = [
    'dist/cockpit.js',
    'dist/cockpit.d.ts',
    'dist/styles.css',
    'dist/assets/cockpit.js',
    'dist/assets/inter.woff2',
    'licenses/Inter-OFL.txt',
    'licenses/JetBrains-Mono-OFL.txt',
  ]

  assert.doesNotThrow(() => assertReactTarball(complete))
  assert.throws(
    () => assertReactTarball(complete.filter((file) => file !== 'licenses/Inter-OFL.txt')),
    /React tarball is missing licenses\/Inter-OFL\.txt/,
  )
  assert.throws(
    () => assertReactTarball(
      complete.filter((file) => file !== 'licenses/JetBrains-Mono-OFL.txt'),
    ),
    /React tarball is missing licenses\/JetBrains-Mono-OFL\.txt/,
  )
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
