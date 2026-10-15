import { KeyRoundIcon, ChevronRightIcon, FolderIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useVaultBrowse, useVaultStatus } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * Pick a Vault key and hand the agent its value.
 *
 * The picker browses NAMES only — mounts, paths, field names. A secret's value
 * is fetched on the host when a container starts and goes straight into it, so
 * no value ever reaches this page. What gets saved is a reference,
 * `vault://<mount>/<path>#<field>`, which is also all that is ever persisted.
 *
 * The container never receives `VAULT_TOKEN` either: it gets the values it was
 * granted, not the ability to read more.
 */
export interface SecretEntry {
  id: string
  label?: string
  env?: string[]
  valueFrom?: string
  required?: boolean
}

/** The longest id the settings routes have always accepted for a custom credential. */
const SECRET_ID_MAX = 64

/**
 * The id a picked field is saved under.
 *
 * Readable — `<mount>/<path>#<field>` — when it fits, so an existing entry
 * keeps the id it was saved with and re-picking it still edits rather than
 * duplicates. A deep Vault path does not fit the 64 characters the settings
 * routes cap an id at, and the machine-wide PUT answered such a pick with a
 * 400; past the cap the id is a short stable hash of the full reference
 * instead. Only the id shortens: `valueFrom` always carries the whole
 * reference, and the id is never parsed — it only names the row.
 */
export function secretIdFor(mount: string, path: string, field: string): string {
  const readable = `${mount}/${path}#${field}`
  if (readable.length <= SECRET_ID_MAX) return readable
  return `vault-${fnv1a64(`vault://${readable}`).slice(0, 12)}`
}

/**
 * FNV-1a, 64-bit, as hex. Synchronous on purpose: `crypto.subtle` is async and
 * exists only in a secure context, and this is an id, not a security boundary —
 * stable and well-spread is all it has to be.
 */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

export function SecretPicker({
  value,
  onChange,
  inherited = [],
  busy = false,
}: {
  value: SecretEntry[]
  onChange: (next: SecretEntry[]) => void
  /** Secrets that come from elsewhere (the machine) — listed, not editable. */
  inherited?: SecretEntry[]
  busy?: boolean
}) {
  const status = useVaultStatus()
  const [picking, setPicking] = useState(false)

  if (status.isPending) {
    return <p className="text-xs text-muted-foreground">Checking Vault…</p>
  }

  const ready = status.data?.authenticated === true

  return (
    <div data-slot="secret-picker" className="flex flex-col gap-3">
      {inherited.length > 0 ? (
        <ul data-slot="secret-inherited" className="flex flex-col gap-1">
          {inherited.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <KeyRoundIcon className="size-3 shrink-0" aria-hidden="true" />
              <code>{entry.env?.[0] ?? entry.id}</code>
              <span>from Isolation defaults</span>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {value.map((entry) => (
          <li
            key={entry.id}
            data-slot="secret-row"
            className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
          >
            <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="text-[12.5px]">{entry.env?.[0] ?? entry.id}</code>
            {/* The reference, not the value — there is no value to show. */}
            <code className="min-w-0 flex-1 truncate text-[11px] text-soft-foreground" title={entry.valueFrom}>
              {entry.valueFrom}
            </code>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={entry.required === true}
                disabled={busy}
                aria-label={`${entry.env?.[0] ?? entry.id} is required`}
                onCheckedChange={(next) => onChange(
                  value.map((e) => (e.id === entry.id ? { ...e, required: next } : e)),
                )}
              />
              required
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              disabled={busy}
              aria-label={`Remove ${entry.env?.[0] ?? entry.id}`}
              onClick={() => onChange(value.filter((e) => e.id !== entry.id))}
            >
              <Trash2Icon className="size-3.5" aria-hidden="true" />
            </Button>
            {entry.required ? (
              <span className="basis-full text-xs text-muted-foreground">
                A task refuses to start when this one cannot be fetched, instead of failing later at something
                that names neither the secret nor Vault.
              </span>
            ) : null}
          </li>
        ))}
        {value.length === 0 && inherited.length === 0 ? (
          <li className="text-xs text-muted-foreground">Nothing passed yet.</li>
        ) : null}
      </ul>

      {/* Vault's own state, in its own words, with the command that fixes it.
          Under launchd the cockpit's environment is the plist's, not the
          shell's — so "it works in my terminal" is the expected confusion here
          and the reason `reason` names the environment explicitly. */}
      {!ready ? (
        <p data-slot="vault-unavailable" className="text-xs text-warning">
          {status.data?.reason || 'Vault is not reachable'}
          {status.data?.fix ? <> — <code>{status.data.fix}</code></> : null}
        </p>
      ) : null}

      {ready && !picking ? (
        <div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}>
            Add a secret…
          </Button>
          {status.data?.address ? (
            <span className="ml-2 text-xs text-muted-foreground">{status.data.address}</span>
          ) : null}
        </div>
      ) : null}

      {ready && picking ? (
        <VaultBrowser
          mounts={status.data?.mounts ?? []}
          mountsError={status.data?.mountsError}
          busy={busy}
          onCancel={() => setPicking(false)}
          onPick={(entry) => {
            setPicking(false)
            // Replace by id so re-picking the same key edits rather than duplicates.
            onChange([...value.filter((e) => e.id !== entry.id), entry])
          }}
        />
      ) : null}
    </div>
  )
}

/** How long the typed mount must sit still before it is browsed. */
const MOUNT_DEBOUNCE_MS = 400

/** Browse one mount a level at a time, then pick a field. */
function VaultBrowser({
  mounts,
  mountsError,
  busy,
  onPick,
  onCancel,
}: {
  mounts: string[]
  /** Set when the mount list could not be read — usually a policy, not a fault. */
  mountsError?: string
  busy: boolean
  onPick: (entry: SecretEntry) => void
  onCancel: () => void
}) {
  const [mount, setMount] = useState(mounts[0] ?? '')
  // What the operator is TYPING into the mount box, committed to `mount` (and
  // so to a browse) only once they pause, press Enter or leave the field.
  // Every browse is a `vault` process on the host; keyed straight off the
  // input, typing `secret` spawned six of them, five for mounts nobody meant.
  const [mountDraft, setMountDraft] = useState(mount)
  const [path, setPath] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [envName, setEnvName] = useState('')
  const browse = useVaultBrowse(mount, path)

  const commitMount = (next: string): void => {
    if (next === mount) return
    setMount(next)
    setPath('')
    setField(null)
  }
  useEffect(() => {
    if (mountDraft === mount) return
    const timer = setTimeout(() => commitMount(mountDraft), MOUNT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // commitMount reads only `mount`, which is already a dependency.
  }, [mountDraft, mount])

  const segments = path === '' ? [] : path.split('/')
  const entries = browse.data?.entries ?? []
  const fields = browse.data?.fields ?? []

  const choose = (name: string): void => {
    setField(name)
    // A sensible default the operator can overwrite: most secrets are named
    // like the variable they end up in, and typing it twice is friction.
    setEnvName(name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
  }

  return (
    <div data-slot="vault-browser" className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {/* Enumerating mounts needs `sys/mounts`, which a sensibly-scoped token
            is not granted — so typing the name is the NORMAL path, not the
            fallback. A dropdown alone left real tokens with an empty picker and
            no way forward. */}
        {mounts.length > 0 ? (
          <select
            className="rounded border bg-background px-1 py-0.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={mount}
            aria-label="Vault mount"
            onChange={(e) => { setMount(e.target.value); setPath(''); setField(null) }}
          >
            {mounts.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <Input
            data-slot="vault-mount"
            className="h-7 w-32 font-mono text-xs"
            placeholder="mount (e.g. kv)"
            aria-label="Vault mount"
            value={mountDraft}
            onChange={(e) => setMountDraft(e.target.value.trim())}
            onBlur={() => commitMount(mountDraft)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitMount(mountDraft) }}
          />
        )}
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => { setPath(''); setField(null) }}
        >
          /
        </button>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3 text-soft-foreground" aria-hidden="true" />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => { setPath(segments.slice(0, index + 1).join('/')); setField(null) }}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {mounts.length === 0 && mountsError ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          This token cannot list mounts ({mountsError}) — type the mount name.
        </p>
      ) : null}

      <ul className="mt-2 flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {browse.isPending ? <li className="text-xs text-muted-foreground">Reading…</li> : null}
        {entries.map((entry) => (
          <li key={entry}>
            <button
              type="button"
              data-slot="vault-entry"
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-muted"
              onClick={() => { setPath([...segments, entry.replace(/\/$/, '')].join('/')); setField(null) }}
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {entry}
            </button>
          </li>
        ))}
        {fields.map((name) => (
          <li key={name}>
            <button
              type="button"
              data-slot="vault-field"
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-muted',
                field === name && 'bg-muted',
              )}
              onClick={() => choose(name)}
            >
              <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {name}
            </button>
          </li>
        ))}
        {/* "Nothing here" and "you are not allowed to look" are different
            answers, and only one of them is worth acting on. A REFUSED
            request (the route's 400 for a name it will not pass to `vault`)
            is a third: it says nothing about the folder, so it must not read
            as an empty one. */}
        {browse.isError ? (
          <li data-slot="vault-browse-error" className="text-xs text-warning">{browse.error.message}</li>
        ) : !browse.isPending && entries.length === 0 && fields.length === 0 ? (
          browse.data?.error ? (
            <li data-slot="vault-browse-error" className="text-xs text-warning">{browse.data.error}</li>
          ) : (
            <li className="text-xs text-muted-foreground">Nothing here.</li>
          )
        ) : null}
      </ul>

      {field ? (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Environment variable
            <Input
              data-slot="secret-env-name"
              className="h-8 w-56 font-mono text-xs"
              value={envName}
              onChange={(e) => setEnvName(e.target.value)}
            />
          </label>
          <code className="min-w-0 flex-1 truncate pb-2 text-[11px] text-soft-foreground">
            vault://{mount}/{path}#{field}
          </code>
          <Button
            size="sm"
            data-slot="secret-add"
            disabled={busy || envName.trim() === ''}
            onClick={() => onPick({
              id: secretIdFor(mount, path, field),
              env: [envName.trim()],
              valueFrom: `vault://${mount}/${path}#${field}`,
            })}
          >
            Add
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      ) : (
        <div className="mt-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      )}
    </div>
  )
}
