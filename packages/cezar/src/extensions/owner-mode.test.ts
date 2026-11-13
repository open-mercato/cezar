import { mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectContext } from '../server/project-context.ts'
import { RunStore } from '../runs/store.ts'

const retained = vi.hoisted(() => [] as unknown[])
vi.mock('./project-runtime.ts', async original => {
  const real = await original<typeof import('./project-runtime.ts')>()
  return { ...real, retainProjectExtensions: (project: unknown, ...rest: unknown[]) => { retained.push(project); return (real.retainProjectExtensions as (...a: unknown[]) => unknown)(project, ...rest) } }
})

const roots: string[] = []
afterEach(async () => { retained.length = 0; vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

// The first owner is shared by every later opener, so the route's owner must carry the real mode (spec 2026-11-12 §1).
it.each([
  { name: 'hosted with the runtime flag', local: false, runtimeAllowed: true },
  { name: 'local', local: true, runtimeAllowed: true },
])('the HTTP extension owner is opened with the cockpit mode: $name', async ({ local, runtimeAllowed }) => {
  const { restoreProjectExtensions, closeProjectExtensions } = await import('../server/extensions.ts')
  const root = await mkdtemp(join(tmpdir(), 'owner-mode-')); roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 })
  vi.stubEnv('CEZ_HOME', join(root, 'home'))
  const dataDir = join(root, '.ai/cezar'), store = RunStore.open(dataDir)
  const project = { id: 'project', root, dataDir, store } as ProjectContext
  try {
    await restoreProjectExtensions(project, () => undefined, { local: () => local, runtimeAllowed: () => runtimeAllowed, browseRoot: () => null })
    expect(retained).toEqual([expect.objectContaining({ mode: local ? 'local' : 'hosted', runtimeAllowed })])
  } finally { await closeProjectExtensions(project); store.flush() }
})
