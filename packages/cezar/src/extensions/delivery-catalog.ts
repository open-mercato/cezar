import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { extensionManifestSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { isVouchedChatArtifact, vouchChatArtifact } from '../chat/registry.ts'
import { canonicalChatProviderSchema } from './chat-selection-store.ts'
import { contained } from './install-files.ts'
import { artifactIntegrity } from './installer.ts'

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
    if (await artifactIntegrity(root) !== stamp.integrity) throw Error('Chat delivery artifact integrity mismatch')
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
