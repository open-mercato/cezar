import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { extensionChatSelectionParamsSchema, extensionManifestSchema, extensionRecordSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { vouchChatArtifact } from '../chat/registry.ts'
import { assertLifecyclePath, atomicLifecycleWrite, withLifecycleFileLock } from '../worktree-lifecycle/store.ts'
import { contained } from './install-files.ts'
import { artifactIntegrity } from './installer.ts'

export const canonicalChatProviderSchema = extensionChatSelectionParamsSchema.shape.provider
export type CanonicalChatProvider = z.infer<typeof canonicalChatProviderSchema>
export const chatSelectionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shipped') }).strict(),
  z.object({
    kind: z.literal('installed'),
    record: extensionRecordSchema.refine(record => !!record.integrity, 'Immutable artifact required'),
    localProviderId: z.string().min(1).max(100),
  }).strict(),
])
export type ChatSelectionTarget = z.infer<typeof chatSelectionTargetSchema>
type InstalledTarget = Extract<ChatSelectionTarget, { kind: 'installed' }>
const selectionSchema = z.object({
  schemaVersion: z.literal(1),
  provider: canonicalChatProviderSchema,
  revision: z.uuid(),
  target: chatSelectionTargetSchema,
}).strict()
export type ChatSelection = z.infer<typeof selectionSchema>
export type SelectedChatArtifact = {
  origin: 'installed'
  provider: CanonicalChatProvider
  localProviderId: string
  extensionId: string
  version: string
  integrity: string
  root: string
  entry: string
  manifest: ExtensionManifest
}
/** A selection that no longer parses: it never means fallback, and it answers only for its own provider. */
export type UnreadableSelection = { provider: CanonicalChatProvider; extensionId?: string; message: string }
const snapshots = new WeakSet<ChatSelection>()
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Durable source selection is independent of installation and live worker leases.
 * Reads never create state. Corrupt or missing selected artifacts never mean fallback.
 * Only the manager's explicit consent transaction may write this store.
 */
export class ChatSelectionStore {
  constructor(private readonly dataDir: string, private readonly home: string) {}

  file(provider: CanonicalChatProvider) {
    return join(this.dataDir, 'extensions', 'chat-selections', `${canonicalChatProviderSchema.parse(provider)}.json`)
  }

  async read(provider: CanonicalChatProvider): Promise<ChatSelection | undefined> {
    const file = this.file(provider)
    let raw: string
    try {
      await assertLifecyclePath(file, this.dataDir)
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    const selected = selectionSchema.parse(JSON.parse(raw))
    if (selected.provider !== provider) throw Error('Chat selection identity mismatch')
    freeze(selected)
    snapshots.add(selected)
    return selected
  }

  /** `read` for code that walks every provider. Storage errors still throw: those are not this record's. */
  async peek(provider: CanonicalChatProvider): Promise<{ selection?: ChatSelection; unreadable?: UnreadableSelection }> {
    try {
      const selection = await this.read(provider)
      return selection ? { selection } : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error
      const file = this.file(provider)
      const extensionId = await readFile(file, 'utf8').then(raw => {
        const id: unknown = (JSON.parse(raw) as { target?: { record?: { manifest?: { id?: unknown } } } })?.target?.record?.manifest?.id
        return typeof id === 'string' ? id : undefined
      }, () => undefined).catch(() => undefined)
      return { unreadable: { provider, ...(extensionId ? { extensionId } : {}), message: `Chat selection for ${provider} is unreadable; repair or delete ${file}` } }
    }
  }

  private async pin(provider: CanonicalChatProvider, target: InstalledTarget) {
    const digest = createHash('sha256').update(target.record.integrity!).digest('hex')
    const owner = createHash('sha256').update(JSON.stringify([await realpath(this.dataDir), provider])).digest('hex')
    return join(this.home, 'extensions', 'leases', target.record.manifest.id, digest, `selection-${owner}`)
  }

  private async verify(provider: CanonicalChatProvider, target: InstalledTarget): Promise<SelectedChatArtifact> {
    const { record, localProviderId } = target
    const integrity = record.integrity!
    const digest = createHash('sha256').update(integrity).digest('hex')
    const root = join(this.home, 'extensions', 'artifacts', record.manifest.id, record.manifest.version, digest)
    await assertLifecyclePath(root, this.home)
    if (await artifactIntegrity(root) !== integrity) throw Error('Selected chat artifact integrity mismatch')
    let pkg: Record<string, unknown> | undefined
    try {
      pkg = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
    } catch (error) {
      if (!missing(error)) throw error
    }
    const manifest = extensionManifestSchema.parse(JSON.parse(await readFile(join(root, 'cezar-extension.json'), 'utf8')))
    if (pkg?.version !== undefined && pkg.version !== manifest.version) throw Error('Selected chat package version mismatch')
    if (!isDeepStrictEqual(manifest, record.manifest)) throw Error('Selected chat manifest mismatch')
    if (!manifest.contributes?.chatProviders?.some(item => item.id === localProviderId)) throw Error('Selected chat provider missing')
    const entry = await realpath(join(root, manifest.entry))
    if (!contained(await realpath(root), entry)) throw Error('Selected chat entry escaped artifact')
    const artifact = freeze({ origin: 'installed' as const, provider, localProviderId, extensionId: manifest.id, version: manifest.version, integrity, root, entry, manifest })
    vouchChatArtifact('selection', artifact)
    return artifact
  }

  async inspect(provider: CanonicalChatProvider, target: InstalledTarget): Promise<SelectedChatArtifact> {
    return this.verify(canonicalChatProviderSchema.parse(provider), chatSelectionTargetSchema.options[1].parse(target))
  }

  async resolve(provider: CanonicalChatProvider): Promise<SelectedChatArtifact | undefined> {
    const selected = await this.read(provider)
    return selected?.target.kind === 'installed' ? this.verify(provider, selected.target) : undefined
  }

  async replace(provider: CanonicalChatProvider, expectedRevision: string | null, input: ChatSelectionTarget): Promise<ChatSelection> {
    return this.writeSelection(provider, expectedRevision, input, true)
  }

  /** Roll back only a frozen snapshot read by this host; missing old bytes stay unavailable. */
  async restore(provider: CanonicalChatProvider, expectedRevision: string, previous: ChatSelection | undefined): Promise<ChatSelection> {
    if (previous && (!snapshots.has(previous) || previous.provider !== provider)) throw Error('Unverified selection snapshot')
    return this.writeSelection(provider, expectedRevision, previous?.target ?? { kind: 'shipped' }, false)
  }

  private async writeSelection(provider: CanonicalChatProvider, expectedRevision: string | null, input: ChatSelectionTarget, verify: boolean): Promise<ChatSelection> {
    const target = chatSelectionTargetSchema.parse(input)
    const file = this.file(provider)
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    await assertLifecyclePath(file, this.dataDir)
    return withLifecycleFileLock(`${file}.lock`, async () => {
      const current = await this.read(provider)
      if ((current?.revision ?? null) !== expectedRevision) throw Error('Chat selection changed; review it again')
      const journal = `${file}.pending`
      const pending = await this.pending(journal)
      const next = selectionSchema.parse({ schemaVersion: 1, provider, revision: randomUUID(), target })
      if (target.kind === 'shipped' && current?.target.kind !== 'installed' && pending.length === 0) {
        await atomicLifecycleWrite(file, next)
        return next
      }
      return withLifecycleFileLock(join(this.home, 'extensions', '.install.lock'), async () => {
        await this.releasePending(provider, journal, pending, current)
        if (verify && target.kind === 'installed') await this.verify(provider, target)
        const candidates = [current?.target, target].filter((item): item is InstalledTarget => item?.kind === 'installed')
        // Persist cleanup intent before creating any pin. A crash at either commit
        // boundary can then be reconciled against the actual durable selection.
        await atomicLifecycleWrite(journal, candidates)
        try {
          if (target.kind === 'installed') {
            const nextPin = await this.pin(provider, target)
            await assertLifecyclePath(nextPin, this.home)
            await mkdir(join(nextPin, '..'), { recursive: true, mode: 0o700 })
            await atomicLifecycleWrite(nextPin, { schemaVersion: 1, provider })
          }
          await atomicLifecycleWrite(file, next)
        } catch (error) {
          await this.releasePending(provider, journal, candidates, await this.read(provider)).catch(() => undefined)
          throw error
        }
        // Metadata is committed. A failed release leaves the durable intent for
        // startup reconciliation or the next selection transaction to retry.
        await this.releasePending(provider, journal, candidates, next).catch(() => undefined)
        return next
      })
    })
  }

  private async pending(journal: string): Promise<InstalledTarget[]> {
    await assertLifecyclePath(journal, this.dataDir)
    try {
      return z.array(chatSelectionTargetSchema.options[1]).max(2).parse(JSON.parse(await readFile(journal, 'utf8')))
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
  }

  private async releasePending(provider: CanonicalChatProvider, journal: string, pending: InstalledTarget[], current: ChatSelection | undefined) {
    const keep = current?.target.kind === 'installed' ? await this.pin(provider, current.target) : undefined
    for (const target of pending) {
      const pin = await this.pin(provider, target)
      if (pin !== keep) {
        await assertLifecyclePath(pin, this.home)
        await rm(pin, { force: true })
      }
    }
    await rm(journal, { force: true })
  }

  /** Explicit startup repair; passive inventory reads never write or acquire locks. */
  async reconcile(provider: CanonicalChatProvider): Promise<void> {
    const file = this.file(provider)
    try {
      await realpath(this.dataDir)
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    await assertLifecyclePath(file, this.dataDir)
    await withLifecycleFileLock(`${file}.lock`, async () => {
      const journal = `${file}.pending`
      const pending = await this.pending(journal)
      if (pending.length === 0) return
      await withLifecycleFileLock(join(this.home, 'extensions', '.install.lock'), async () => {
        await this.releasePending(provider, journal, pending, await this.read(provider))
      })
    })
  }
}
