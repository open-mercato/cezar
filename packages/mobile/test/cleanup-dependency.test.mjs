import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
// Exercise the parent actually resolved by Capacitor's CLI, including nested installations.
const cliDirectory = dirname(require.resolve('@capacitor/cli/package.json'))
const { rimraf } = require(require.resolve('rimraf', { paths: [cliDirectory] }))

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cezar-mobile-cleanup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

// Capacitor's own calls: rimraf.sync on a literal path, no glob option
// (dist/ios/build.js:90, dist/tasks/migrate.js:247 and :306).
test('Capacitor cleanup parent: sync removes a literal directory tree and keeps siblings', async t => {
  const directory = await scratch(t)
  await mkdir(join(directory, 'App.xcarchive', 'Products'), { recursive: true })
  await writeFile(join(directory, 'App.xcarchive', 'Products', 'App'), 'archive')
  await writeFile(join(directory, 'keep.txt'), 'keep')

  assert.equal(rimraf.sync(join(directory, 'App.xcarchive')), true)
  assert.deepEqual(await readdir(directory), ['keep.txt'])
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'keep')
})

test('Capacitor cleanup parent: sync tolerates a missing path', async t => {
  const directory = await scratch(t)
  assert.equal(rimraf.sync(join(directory, 'build')), true)
  assert.deepEqual(await readdir(directory), [])
})

test('Capacitor cleanup parent: sync without glob treats an extglob path literally', async t => {
  // migrate.js:306 passes `node_modules/@capacitor/!(cli)` without { glob: true }.
  const directory = await scratch(t)
  await mkdir(join(directory, '@capacitor', 'cli'), { recursive: true })
  await mkdir(join(directory, '@capacitor', 'core'), { recursive: true })

  assert.equal(rimraf.sync(join(directory, '@capacitor', '!(cli)')), true)
  assert.deepEqual((await readdir(join(directory, '@capacitor'))).sort(), ['cli', 'core'])
})

// The glob path is where the patched minimatch actually runs.
test('Capacitor cleanup parent expands globs and preserves unmatched files', async t => {
  const directory = await scratch(t)
  await writeFile(join(directory, 'file.tmp'), 'temporary')
  await mkdir(join(directory, 'folder.tmp'))
  await writeFile(join(directory, 'folder.tmp', 'nested'), 'temporary')
  await writeFile(join(directory, 'keep.txt'), 'keep')

  assert.equal(await rimraf(join(directory, '*.tmp'), { glob: true }), true)
  assert.deepEqual(await readdir(directory), ['keep.txt'])
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'keep')
})

test('Capacitor cleanup parent tolerates an unmatched cleanup glob', async t => {
  const directory = await scratch(t)
  await writeFile(join(directory, 'keep.txt'), 'keep')

  assert.equal(await rimraf(join(directory, '*.tmp'), { glob: true }), true)
  assert.deepEqual(await readdir(directory), ['keep.txt'])
})
