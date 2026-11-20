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

test('Capacitor cleanup parent expands globs and preserves unmatched files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cezar-mobile-cleanup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'file.tmp'), 'temporary')
  await mkdir(join(directory, 'folder.tmp'))
  await writeFile(join(directory, 'folder.tmp', 'nested'), 'temporary')
  await writeFile(join(directory, 'keep.txt'), 'keep')

  assert.equal(await rimraf(join(directory, '*.tmp'), { glob: true }), true)
  assert.deepEqual(await readdir(directory), ['keep.txt'])
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'keep')
})

test('Capacitor cleanup parent tolerates an unmatched cleanup glob', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cezar-mobile-cleanup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'keep.txt'), 'keep')

  assert.equal(await rimraf(join(directory, '*.tmp'), { glob: true }), true)
  assert.deepEqual(await readdir(directory), ['keep.txt'])
})
