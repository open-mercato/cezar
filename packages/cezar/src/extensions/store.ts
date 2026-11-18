import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { extensionIdParamsSchema, extensionRecordSchema, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { cezarHomeDir } from '../paths.ts'
import { assertLifecyclePath, atomicLifecycleWrite, withLifecycleFileLock } from '../worktree-lifecycle/store.ts'

/** What can still be told about a row that no longer parses. `file` means the whole registry is
 *  unreadable, so any id may be hidden in it. */
export type UnreadableRecord = { id?: string; name?: string; version?: string; source?: string; file?: true }
export type StoreSnapshot = { records: ExtensionRecord[]; unreadable: UnreadableRecord[] }
/** Whether `id`'s stored state is hidden: consent for it must then read as absent, never as a default. */
export const isUnreadable = (rows: UnreadableRecord[], id: string) => rows.some(row => row.file || row.id === id)

// Bounded to the record schema, so what is reported about a bad row always passes the response contract.
const text = (value: unknown, max: number) => typeof value === 'string' && value && value.length <= max ? value : undefined
function describe(row: unknown): UnreadableRecord {
  const { manifest, source } = (row ?? {}) as { manifest?: { id?: unknown; name?: unknown; version?: unknown }; source?: unknown }
  const fields = { id: extensionIdParamsSchema.shape.extensionId.safeParse(manifest?.id).data, name: text(manifest?.name, 200), version: text(manifest?.version, 100), source: text(source, 4096) }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as UnreadableRecord
}

/** Global installation registry. Project enablement is owned by the manager. */
export class ExtensionStore {
  constructor(readonly file = join(cezarHomeDir(), 'extensions', 'registry.json')) {}
  async list(): Promise<ExtensionRecord[]> { return (await this.snapshot()).records }
  async snapshot(): Promise<StoreSnapshot> {
    const { records, invalid, damaged } = await this.read()
    return { records, unreadable: damaged ? [{ file: true }] : invalid.map(describe) }
  }
  private async read(): Promise<{ records: ExtensionRecord[]; invalid: unknown[]; damaged: boolean }> {
    let raw: unknown
    try {
      await assertLifecyclePath(this.file, dirname(this.file))
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { records: [], invalid: [], damaged: code !== 'ENOENT' && code !== 'ENOTDIR' }
    }
    if (!Array.isArray(raw)) return { records: [], invalid: [], damaged: true }
    const records: ExtensionRecord[] = [], invalid: unknown[] = []
    for (const item of raw) {
      const parsed = extensionRecordSchema.safeParse(item)
      if (parsed.success) records.push(parsed.data)
      else invalid.push(item)
    }
    return { records, invalid, damaged: false }
  }
  async replace(records: ExtensionRecord[]): Promise<void> { await this.update(() => records) }
  async update(fn: (records: ExtensionRecord[]) => ExtensionRecord[]): Promise<ExtensionRecord[]> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    await assertLifecyclePath(this.file, dirname(this.file))
    return withLifecycleFileLock(`${this.file}.lock`, async () => {
      const { records, invalid, damaged } = await this.read()
      // Overwriting would turn "unreadable, so not enabled" into "no record, so default".
      if (damaged) throw new Error(`Extension registry is unreadable; repair or delete ${this.file}`)
      const next = fn(records).map(record => extensionRecordSchema.parse(record))
      // A row stays until a readable record for its id replaces it.
      const replaced = new Set(next.map(record => record.manifest.id))
      await atomicLifecycleWrite(this.file, [...next, ...invalid.filter(row => !replaced.has(describe(row).id ?? ''))])
      return next
    })
  }
}
