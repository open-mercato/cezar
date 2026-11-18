import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotExtensionState } from './updates.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('preserves old local state on failed update and restores absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-update-')); roots.push(root)
  const state = join(root, 'state'); await mkdir(state)
  await writeFile(join(state, 'data'), 'old')
  const snapshot = await snapshotExtensionState(state)
  await writeFile(join(state, 'data'), 'migration failed')
  await snapshot.restore()
  expect(await readFile(join(state, 'data'), 'utf8')).toBe('old')
  const absent = join(root, 'absent')
  const empty = await snapshotExtensionState(absent)
  await mkdir(absent)
  await empty.restore()
  expect(await readdir(root)).not.toContain('absent')
})
