// Live workers pin immutable artifacts across cockpit processes. Pins live outside the artifact:
// modifying an installed directory would invalidate its integrity. The installer lock orders pin
// acquisition against pruning. A dead process's pin is reaped conservatively (PID reuse retains it).
import { mkdir, writeFile, readdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertLifecyclePath, withLifecycleFileLock } from '../worktree-lifecycle/store.ts'

const directory = (home: string, id: string, digest: string) => join(home, 'extensions', 'leases', id, digest)

export async function pinArtifact(home: string, id: string, digest: string, artifact: string): Promise<() => Promise<void>> {
  return withLifecycleFileLock(join(home, 'extensions', '.install.lock'), async () => {
    await access(artifact)
    const dir = directory(home, id, digest)
    await assertLifecyclePath(dir, home)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${process.pid}-${randomUUID()}`)
    await writeFile(file, '', { mode: 0o600, flag: 'wx' })
    return async () => { await rm(file, { force: true }) }
  })
}

/** Caller holds .install.lock. Unknown owners are retained, never guessed dead. */
export async function artifactPinned(home: string, id: string, digest: string): Promise<boolean> {
  const dir = directory(home, id, digest)
  await assertLifecyclePath(dir, home)
  let live = false
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const pid = Number(/^(\d+)-/.exec(name)?.[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) { live = true; continue }
    try {
      process.kill(pid, 0)
      live = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(join(dir, name), { force: true })
      else live = true
    }
  }
  return live
}
