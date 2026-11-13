import { constants } from 'node:fs'
import { open, lstat, mkdir, opendir, chmod } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/** Whether `path` lies inside `root`; both must already be resolved. */
export function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

/** `metadata` caps the cumulative registry packument bytes parsed in-process (default 64 MiB). */
export type InstallLimits = { files: number; bytes: number; depth?: number; metadata?: number }
export const INSTALL_LIMITS: InstallLimits = { files: 100_000, bytes: 512 * 1024 * 1024, depth: 64 }
export const limitsError = () => new Error('extension artifact exceeds installation limits')
export class InstallBudget {
  files = 0
  bytes = 0
  expanded = 0
  headers = 0
  constructor(readonly limits: InstallLimits) {}
  entry(depth: number) {
    if (++this.files > this.limits.files || depth > (this.limits.depth ?? 64)) throw limitsError()
  }
  archiveBytes(bytes: number) {
    this.expanded += bytes
    if (this.expanded > this.limits.bytes + Math.min(64 * 1024 * 1024, this.limits.files * 1024)) throw limitsError()
  }
  data(bytes: number) {
    this.bytes += bytes
    if (this.bytes > this.limits.bytes) throw limitsError()
  }
}
/** NONBLOCK matters even with NOFOLLOW: opening a FIFO otherwise waits before fstat. */
export async function openRegular(path: string, maxBytes: number) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('extension artifact contains a symbolic link or special file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new Error('extension artifact changed or contains a special file')
    if (info.size > maxBytes) throw limitsError()
    return handle
  } catch (error) { await handle.close(); throw error }
}
export async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  const file = await openRegular(path, maxBytes)
  try {
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1))
      const { bytesRead } = await file.read(chunk)
      if (!bytesRead) return Buffer.concat(chunks, total)
      total += bytesRead
      if (total > maxBytes) throw limitsError()
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally { await file.close() }
}
export const MANIFEST_BYTES = 1024 * 1024

/** Count entries as they are copied, not just in a preflight which the source can race. */
export async function copyArtifact(source: string, target: string, budget: InstallBudget, skip: (path: string) => boolean = () => false, depth = 0): Promise<void> {
  const info = await lstat(source)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('extension artifact must be a directory without symbolic links')
  await mkdir(target, { recursive: true })
  for await (const item of await opendir(source)) {
    const from = join(source, item.name), to = join(target, item.name)
    if (skip(from)) continue
    budget.entry(depth + 1)
    const stat = await lstat(from)
    if (stat.isDirectory()) await copyArtifact(from, to, budget, skip, depth + 1)
    else {
      const input = await openRegular(from, budget.limits.bytes - budget.bytes)
      try {
        const output = await open(to, 'wx', stat.mode & 0o777)
        try {
          const buffer = Buffer.alloc(64 * 1024)
          for (;;) {
            const { bytesRead } = await input.read(buffer)
            if (!bytesRead) break
            budget.data(bytesRead)
            await output.writeFile(buffer.subarray(0, bytesRead))
          }
        } finally { await output.close() }
      } finally { await input.close() }
    }
  }
  await chmod(target, info.mode & 0o777)
}
