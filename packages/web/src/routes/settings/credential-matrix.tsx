import { Switch } from '@/components/ui/switch'

import type { IsolationStatusResponse } from '@open-mercato/cezar-api-client'

export type Choice = boolean | { mode?: 'mount' | 'copy'; keys?: string[] }
type Catalog = IsolationStatusResponse['credentials']['catalog']

function nextEnabled(
  current: Record<string, Choice>,
  id: string,
  value: Choice,
): Record<string, Choice> {
  const next = { ...current }
  if (value === false) delete next[id]
  else next[id] = value
  return next
}

/** Tick or untick one file of a narrowable credential, preserving the rest. */
function nextKeys(choice: Choice | undefined, name: string, on: boolean): string[] {
  const current = (typeof choice === 'object' && choice?.keys) || []
  return on ? [...current.filter((k) => k !== name), name] : current.filter((k) => k !== name)
}

/** OpenSSH loads these by name with no `config` entry; anything else needs one. */
const DEFAULT_KEY_NAMES = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_dsa']

/**
 * The credential matrix, shared by the per-project Isolation page and the
 * machine-wide defaults.
 *
 * One implementation on purpose: the two differ only in where the answer is
 * SAVED, and the parts worth getting right — that a missing credential reads as
 * unavailable rather than off, that narrowed ssh keys are copied, that a key
 * without `config` or `known_hosts` will not authenticate — are the same
 * wherever the question is asked. Two copies would drift on exactly those.
 */
export function CredentialMatrix({
  catalog,
  value,
  onChange,
  busy = false,
}: {
  catalog: Catalog
  value: Record<string, Choice>
  onChange: (next: Record<string, Choice>) => void
  busy?: boolean
}) {
  return (
        <ul className="flex flex-col gap-2">
          {catalog.map((source) => {
            const choice = value[source.id]
            const on = Boolean(choice)
            const mode = (typeof choice === 'object' && choice?.mode) || source.defaultMode
            const picked = (typeof choice === 'object' && choice?.keys) || []
            const names = source.entries.map((e) => e.name)
            // Both warnings apply only once the operator has started picking —
            // an untouched credential is not yet a misconfiguration.
            const missingKnownHosts = picked.length > 0
              && names.includes('known_hosts') && !picked.includes('known_hosts')
            const missingConfig = picked.length > 0
              && names.includes('config') && !picked.includes('config')
              && picked.some((k) => !DEFAULT_KEY_NAMES.includes(k) && k !== 'config' && k !== 'known_hosts')
            return (
              <li key={source.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Switch
                  checked={on}
                  // A credential this machine does not have reads as unavailable,
                  // not as "off": the two call for different next steps.
                  disabled={!source.present || busy}
                  onCheckedChange={(next) => onChange(
                    nextEnabled(value, source.id, next ? { mode } : false),
                  )}
                  aria-label={source.label}
                />
                <span className={source.present ? '' : 'text-muted-foreground'}>{source.label}</span>
                {on && picked.length === 0 && source.kind !== 'file' ? (
                  <select
                    className="rounded border bg-background px-1 py-0.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    value={mode}
                    disabled={busy}
                    aria-label={`${source.label} passthrough mode`}
                    onChange={(e) => onChange(
                      nextEnabled(value, source.id, {
                        mode: e.target.value as 'mount' | 'copy',
                        ...(picked.length > 0 ? { keys: picked } : {}),
                      }),
                    )}
                  >
                    <option value="mount">mount (live)</option>
                    <option value="copy">copy (snapshot)</option>
                  </select>
                ) : null}
                {/* Narrowed passthrough is always a copy, so the mount/copy
                    control would be a lie while files are ticked. Say which one
                    is in force instead of offering a choice that is not real. */}
                {on && (picked.length > 0 || source.kind === 'file') ? (
                  <span className="rounded border px-1 py-0.5 text-xs text-muted-foreground">copied</span>
                ) : null}
                {!source.present ? (
                  <span className="text-xs text-muted-foreground">not on this machine</span>
                ) : source.note ? (
                  <span className="basis-full text-xs text-muted-foreground">{source.note}</span>
                ) : null}

                {/* The file picker, for a credential that can be narrowed. */}
                {on && source.entries.length > 0 ? (
                  <div data-slot="credential-entries" className="basis-full pl-9">
                    <ul className="flex flex-col gap-1">
                      {source.entries.map((entry) => {
                        const checked = picked.includes(entry.name)
                        return (
                          <li key={entry.name}>
                            <label className="flex cursor-pointer items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                data-slot="credential-entry"
                                className="size-3.5 shrink-0"
                                checked={checked}
                                disabled={busy}
                                onChange={(e) => onChange(
                                  nextEnabled(value, source.id, {
                                    mode,
                                    keys: nextKeys(choice, entry.name, e.target.checked),
                                  }),
                                )}
                              />
                              <code>{entry.name}</code>
                              {entry.detail ? (
                                <span className="text-muted-foreground">{entry.detail}</span>
                              ) : null}
                              {entry.kind === 'config' ? (
                                <span className="text-muted-foreground">host aliases and IdentityFile</span>
                              ) : null}
                              {entry.kind === 'known-hosts' ? (
                                <span className="text-muted-foreground">trusted host keys</span>
                              ) : null}
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                    {/* Three things that decide whether ssh actually works in
                        the container, each of which fails as an unrelated-looking
                        error hours later. */}
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {picked.length === 0
                        ? 'Nothing ticked — the whole ~/.ssh directory is passed, which gives the agent every host every key reaches.'
                        : 'Ticked files are copied into the container; your own keys cannot be modified by it.'}
                    </p>
                    {missingKnownHosts ? (
                      <p className="mt-1 text-xs text-warning">
                        No <code>known_hosts</code>: ssh cannot verify a host it has never seen and will refuse the
                        connection outright, since nothing in a container can answer its prompt.
                      </p>
                    ) : null}
                    {missingConfig ? (
                      <p className="mt-1 text-xs text-warning">
                        No <code>config</code>: ssh only tries keys named <code>id_ed25519</code>, <code>id_rsa</code>
                        {' '}and friends on its own, so a key named anything else is never offered without it.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
  )
}
