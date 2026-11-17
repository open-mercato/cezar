import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const calls: string[] = []
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: (...args: Parameters<typeof fs.open>) => { calls.push(`open ${String(args[0])}`); return fs.open(...args) },
    lstat: (...args: Parameters<typeof fs.lstat>) => { calls.push(`lstat ${String(args[0])}`); return fs.lstat(...args) },
  }
})
const { readRegular } = await import('./install-files.ts')

const roots: string[] = []
afterEach(async () => { calls.length = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('opens the path before inspecting it, so validation reads the opened file (CodeQL fs race)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'install-files-')); roots.push(root)
  const file = join(root, 'manifest.json')
  await writeFile(file, '{}')
  expect((await readRegular(file, 1024)).toString()).toBe('{}')
  const onPath = calls.filter(call => call.endsWith(file))
  expect(onPath[0]).toBe(`open ${file}`)
})

it('still refuses a symbolic link when the open itself does not follow it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'install-files-')); roots.push(root)
  await writeFile(join(root, 'target'), '{}'); await symlink(join(root, 'target'), join(root, 'link'))
  await expect(readRegular(join(root, 'link'), 1024)).rejects.toThrow('symbolic link')
})
