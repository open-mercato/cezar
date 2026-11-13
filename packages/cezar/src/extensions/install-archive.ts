import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createGunzip } from 'node:zlib'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tar from 'tar-stream'
import { InstallBudget, limitsError } from './install-files.ts'

/** No npm/tar subprocess: reject headers and charge bytes BEFORE creating filesystem entries.
 * tar-stream itself refuses a PAX/GNU long header over 4 MiB before buffering it (pinned by test). */
export async function extractRegistryArchive(file: string, target: string, budget: InstallBudget, depth = 0): Promise<void> {
  const extract = tar.extract()
  const dirs = new Set<string>([''])
  const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try { budget.archiveBytes(chunk.length); callback(null, chunk) } catch (error) { callback(error as Error) }
  } })
  async function directory(path: string) {
    const parts = path ? path.split('/') : []
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (dirs.has(dir)) continue
      budget.entry(depth + i)
      await mkdir(join(target, dir))
      dirs.add(dir)
    }
  }
  await mkdir(target, { recursive: true })
  let pending: Promise<void> = Promise.resolve()
  extract.on('entry', (header, stream, next) => {
    // A rejected header has no file pipeline listening to its entry stream yet.
    stream.on('error', () => undefined)
    pending = (async () => {
      if (++budget.headers > budget.limits.files) throw limitsError()
      const raw = header.name.replace(/\/$/, '')
      if (raw.length > 4096) throw new Error('unsafe extension archive path')
      const parts = raw.split('/')
      if (parts[0] !== 'package' || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes(':') || /[\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('unsafe extension archive path')
      const path = parts.slice(1).join('/')
      if (header.type !== 'directory' && header.type !== 'file') throw new Error('extension artifact contains a symbolic link or special file')
      if (header.type === 'directory') {
        if (header.size) throw new Error('invalid extension archive directory')
        await directory(path)
        stream.resume()
      } else {
        if (!path) throw new Error('unsafe extension archive path')
        budget.entry(depth + parts.length - 1)
        if (!Number.isSafeInteger(header.size ?? 0) || (header.size ?? 0) < 0) throw new Error('invalid extension archive size')
        budget.data(header.size ?? 0)
        await directory(dirname(path) === '.' ? '' : dirname(path))
        await pipeline(stream, createWriteStream(join(target, path), { flags: 'wx', mode: (header.mode ?? 0o644) & 0o777 }))
      }
      next()
    })().catch(error => { extract.destroy(error as Error) })
  })
  try { await pipeline(createReadStream(file), createGunzip(), guard, extract) } finally { await pending }
}
