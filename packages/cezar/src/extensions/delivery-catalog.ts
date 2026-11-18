import { createHash } from 'node:crypto'
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { extensionManifestSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { isVouchedChatArtifact, vouchChatArtifact } from '../chat/registry.ts'
import { canonicalChatProviderSchema } from './chat-selection-store.ts'
import { contained, InstallBudget, INSTALL_LIMITS, readRegular } from './install-files.ts'

export function chatDeliveryPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
}
const stampSchema = z.object({
  provider: canonicalChatProviderSchema,
  extensionId: z.string(),
  version: z.string(),
  integrity: z.string().startsWith('sha512-'),
}).strict()
export type ChatDeliveryArtifact = z.infer<typeof stampSchema> & { origin: 'shipped'; root: string; entry: string; manifest: ExtensionManifest }

function freezeVerified<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeVerified(child)
    Object.freeze(value)
  }
  return value
}
export function isVerifiedChatDelivery(value: object): value is ChatDeliveryArtifact { return isVouchedChatArtifact('delivery', value) }

/** Digest of a shipped artifact as npm installs it: `/` paths and no mode bits, because the
 *  installing user's umask and platform decide those (#2168 review). Mirrors build-chat-delivery.mjs. */
export async function shippedArtifactIntegrity(root: string): Promise<string> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('extension artifact must be a directory without symbolic links')
  const hash = createHash('sha512')
  const budget = new InstallBudget(INSTALL_LIMITS)
  async function visit(dir: string, depth: number): Promise<void> {
    const names: string[] = []
    for await (const entry of await opendir(dir)) { budget.entry(depth + 1); names.push(entry.name) }
    for (const name of names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      const path = join(dir, name)
      const info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('extension artifact contains a symbolic link or special file')
      hash.update(JSON.stringify([relative(root, path).split(sep).join('/'), info.isDirectory() ? 'directory' : 'file']))
      if (info.isDirectory()) await visit(path, depth + 1)
      else {
        const contents = await readRegular(path, INSTALL_LIMITS.bytes - budget.bytes)
        budget.data(contents.length)
        hash.update(contents)
      }
    }
  }
  await visit(root, 0)
  return `sha512-${hash.digest('base64')}`
}

/** Whole-catalog reads are metadata (inventory, route guards): one verification per catalog file. */
const verifiedCatalogs = new Map<string, { stamp: string; artifacts: readonly ChatDeliveryArtifact[] }>()

/** Only the host distribution catalog may grant a historical provider alias.
 * Catalog identity is validated as a whole; unavailable artifacts do not hide healthy peers.
 * A provider-specific request precedes activation, so it always re-hashes the bytes and
 * preserves its verification error for startup diagnostics.
 */
export async function loadChatDeliveryCatalog(packageRoot = chatDeliveryPackageRoot(), provider?: ChatDeliveryArtifact['provider']): Promise<ChatDeliveryArtifact[]> {
  const directory = join(packageRoot, 'dist', 'chat-plugins')
  const catalog = join(directory, 'catalog.json')
  const info = provider ? undefined : await stat(catalog)
  const fingerprint = info && `${info.ino}:${info.mtimeMs}:${info.size}`
  const cached = verifiedCatalogs.get(packageRoot)
  if (fingerprint && cached?.stamp === fingerprint) return [...cached.artifacts]
  const stamps = z.array(stampSchema).length(canonicalChatProviderSchema.options.length).parse(JSON.parse(await readFile(catalog, 'utf8')))
  if (new Set(stamps.map(item => item.provider)).size !== stamps.length || new Set(stamps.map(item => item.extensionId)).size !== stamps.length) {
    throw Error('Duplicate delivery identity')
  }
  const results = await Promise.allSettled(stamps.filter(stamp => !provider || stamp.provider === provider).map(async stamp => {
    const root = join(directory, stamp.provider)
    if (await shippedArtifactIntegrity(root) !== stamp.integrity) throw Error('Chat delivery artifact integrity mismatch')
    const manifest = extensionManifestSchema.parse(JSON.parse(await readFile(join(root, 'cezar-extension.json'), 'utf8')))
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    if (
      manifest.id !== stamp.extensionId || manifest.version !== stamp.version || pkg.version !== stamp.version
      || manifest.contributes?.chatProviders?.length !== 1 || manifest.contributes.chatProviders[0]?.id !== stamp.provider
    ) throw Error('Chat delivery identity mismatch')
    const entry = await realpath(join(root, manifest.entry))
    if (!contained(await realpath(root), entry)) throw Error('Chat delivery entry escaped artifact')
    const artifact = freezeVerified({ ...stamp, origin: 'shipped' as const, root, entry, manifest })
    vouchChatArtifact('delivery', artifact)
    return artifact
  }))
  const artifacts: ChatDeliveryArtifact[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') artifacts.push(result.value)
    else if (provider) throw result.reason
  }
  if (fingerprint && artifacts.length === stamps.length) verifiedCatalogs.set(packageRoot, { stamp: fingerprint, artifacts })
  return artifacts
}
