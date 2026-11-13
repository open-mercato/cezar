import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RunStore } from '../runs/store.ts'
import type { RunManager } from '../workflows/run.ts'
import { ExtensionManager } from '../extensions/manager.ts'
import * as projectRuntime from '../extensions/project-runtime.ts'
import { createApp } from './server.ts'

it('boots and disposes with an empty readonly home without background writes or rejections', async () => {
  const home = await mkdtemp(join(tmpdir(), 'extensions-boot-home-'))
  const repoRoot = await mkdtemp(join(tmpdir(), 'extensions-boot-repo-'))
  const store = RunStore.open(join(repoRoot, '.ai', 'cezar'))
  const dispose: Array<() => void | Promise<void>> = []
  vi.stubEnv('CEZ_HOME', home)
  await chmod(home, 0o500)
  try {
    const restore = vi.spyOn(ExtensionManager.prototype, 'restore')
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: 'test', onDispose: fn => { dispose.push(fn) } })
    expect((await app.request('http://localhost/api/v1/health', { headers: { host: 'localhost' } })).status).toBe(200)
    // The boot restore is deliberately fire-and-forget; let it finish before teardown.
    await vi.waitFor(() => expect(restore).toHaveBeenCalled())
    await restore.mock.results[0]!.value
    expect(await readdir(home)).toEqual([])
    for (const cleanup of dispose.splice(0)) await cleanup()
    await chmod(home, 0o700)
    await rm(home, { recursive: true, force: true })
  } finally {
    vi.restoreAllMocks()
    for (const cleanup of dispose) await cleanup()
    vi.unstubAllEnvs()
    store.flush()
    await chmod(home, 0o700).catch(() => undefined)
    await rm(home, { recursive: true, force: true })
    await rm(repoRoot, { recursive: true, force: true })
  }
})

it('warns once and keeps serving when the boot restore rejects', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'extensions-boot-reject-'))
  const store = RunStore.open(join(repoRoot, '.ai', 'cezar'))
  const retain = vi.spyOn(projectRuntime, 'retainProjectExtensions').mockRejectedValue(new Error('owner mismatch'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const restoreWarnings = () => warn.mock.calls.filter(([message]) => String(message).includes('owner mismatch'))
  try {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' })
    await vi.waitFor(() => expect(restoreWarnings()).toHaveLength(1))
    expect(retain).toHaveBeenCalled()
    expect((await app.request('http://localhost/api/v1/health', { headers: { host: 'localhost' } })).status).toBe(200)
  } finally {
    vi.restoreAllMocks()
    store.flush()
    await rm(repoRoot, { recursive: true, force: true })
  }
})
