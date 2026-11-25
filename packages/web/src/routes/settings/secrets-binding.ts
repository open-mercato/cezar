import {
  secretBindingSchema,
  type SecretAudience, type SecretBinding, type SecretBindingScheme, type SecretsList,
} from '@open-mercato/cezar-api-client'

export interface BindingFields { hosts: string; header: string; scheme: SecretBindingScheme; sentinel: string }

export const EMPTY_BINDING_FIELDS: BindingFields = { hosts: '', header: 'Authorization', scheme: 'bearer', sentinel: '' }

export interface BindingPreset { id: string; label: string; help: string; fields: Omit<BindingFields, 'sentinel'> }

export const BINDING_PRESETS: readonly BindingPreset[] = [
  {
    id: 'github', label: 'GitHub over HTTPS',
    help: 'git push and clone over https: scheme basic, hosts github.com and api.github.com.',
    fields: { hosts: 'github.com, api.github.com', header: 'Authorization', scheme: 'basic' },
  },
  {
    id: 'bearer', label: 'Bearer token',
    help: 'Providers that read Authorization: Bearer <key>: scheme bearer, the provider’s API host.',
    fields: { hosts: '', header: 'Authorization', scheme: 'bearer' },
  },
  {
    id: 'api-key', label: 'x-api-key header',
    help: 'Providers that read the key from a header of its own: scheme raw sends the value as is.',
    fields: { hosts: '', header: 'x-api-key', scheme: 'raw' },
  },
]

export const bindingSummary = (binding: SecretBinding) =>
  `${binding.hosts.join(', ')} · ${binding.header} (${binding.scheme})${binding.sentinel ? ` · $${binding.sentinel}` : ''}`

export const fieldsOf = (binding: SecretBinding): BindingFields => ({
  hosts: binding.hosts.join(', '), header: binding.header, scheme: binding.scheme, sentinel: binding.sentinel ?? '',
})

export function parseBinding({ hosts, header, scheme, sentinel }: BindingFields): { binding?: SecretBinding; issue?: string } {
  const parsed = secretBindingSchema.safeParse({
    hosts: [...new Set(hosts.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))].sort(),
    header: header.trim(),
    scheme,
    ...(sentinel.trim() ? { sentinel: sentinel.trim() } : {}),
  })
  return parsed.success ? { binding: parsed.data } : { issue: parsed.error.issues[0]?.message ?? 'invalid binding' }
}

const LEGACY_LABELS: Record<Exclude<SecretAudience, 'proxy'>, string> = {
  checks: 'check steps',
  cezar: 'cezar itself',
}

export const usageSummary = (audiences: readonly SecretAudience[]) =>
  `Not proxied (legacy: ${audiences.filter((a): a is Exclude<SecretAudience, 'proxy'> => a !== 'proxy').map((a) => LEGACY_LABELS[a]).join(' · ')})`

export function keyBackendNote(keyBackend: SecretsList['keyBackend']): string {
  return keyBackend === 'keychain'
    ? 'Encrypted with a data key kept in your OS keychain.'
    : 'Encrypted with a data key in ~/.cezar/secrets/.key (0600) — no OS keychain is available on this machine, so this is a private file, not a vault.'
}

export const FILE_KEY_PROXY_NOTE =
  'Proxy secrets cannot be used while the data key is a file: the Vito launcher refuses a file key and will not resolve them. Make an OS keychain available to use them.'
