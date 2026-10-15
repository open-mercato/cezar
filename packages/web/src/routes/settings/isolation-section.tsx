import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { IsolationStatusResponse } from '@open-mercato/cezar-api-client'
import { decideIsolationSuggestions, putConfig } from '@/api/client'
import { queryKeys, useIsolationStatus } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { CredentialMatrix, type Choice } from './credential-matrix'
import { SecretPicker, type SecretEntry } from './secret-picker'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/**
 * Project settings → Isolation: run this project's agents inside a container
 * instead of on this machine.
 *
 * The page answers two questions that are deliberately NOT merged, because they
 * fail differently and are fixed differently:
 *
 *  - **Can this machine isolate?** Is a container runtime installed, and on
 *    macOS/Windows is its VM running. Nothing the project can configure changes
 *    this, and each failure has exactly one command that fixes it — so the
 *    server sends that command and this page shows it verbatim.
 *  - **Should this project isolate?** The operator's switch.
 *
 * A single boolean would make the switch unexplainable: "off" would mean both
 * "you turned it off" and "your VM is stopped". So the switch reflects the
 * SETTING, and a separate line states what a task started right now would
 * actually do. When those disagree, the disagreement is the most important
 * thing on the page and is rendered as such rather than as a silent default.
 */
export function IsolationSection() {
  const { data, isPending, refetch, isFetching } = useIsolationStatus()
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (enabled: boolean) => putConfig({ sandbox: { enabled } }),
    // The switch's own source of truth is /isolation (it also carries
    // `effective`), so refresh that rather than trusting the PUT's echo.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.isolation })
      void queryClient.invalidateQueries({ queryKey: queryKeys.config })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const saveCredentials = useMutation({
    mutationFn: (enabledMap: Record<string, boolean | { mode?: 'mount' | 'copy' }>) =>
      putConfig({ sandbox: { credentials: { enabled: enabledMap } } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const saveSecrets = useMutation({
    mutationFn: (custom: unknown[]) =>
      putConfig({ sandbox: { credentials: { custom: custom as never } } }),
    // Shown the moment it is picked. The picker closes on Add, so until the
    // save answered the page looked as if nothing had happened — and with the
    // credential push to running containers in that answer, it took most of a
    // minute. A failed save puts the list back.
    onMutate: async (custom: unknown[]) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.isolation })
      const previous = queryClient.getQueryData<IsolationStatusResponse>(queryKeys.isolation)
      if (previous) {
        queryClient.setQueryData<IsolationStatusResponse>(queryKeys.isolation, {
          ...previous,
          credentials: { ...previous.credentials, own: { ...previous.credentials.own, custom } },
        })
      }
      return { previous }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error, _custom, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.isolation, context.previous)
      toast(error.message, { tone: 'danger' })
    },
  })
  const saveResources = useMutation({
    mutationFn: (patch: { memory?: string | null; cpus?: number | null; shmSize?: string }) =>
      putConfig({ sandbox: { resources: patch } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const decide = useMutation({
    mutationFn: (body: { accept?: string[]; dismiss?: string[] }) => decideIsolationSuggestions(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (isPending || !data) {
    return (
      <p data-slot="isolation-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Checking this machine for a container runtime…
      </p>
    )
  }

  const { runtime, enabled, effective, image, hasContainerfile, suggestions, credentials, resources } = data
  // The one case worth shouting about: the operator asked for isolation and is
  // not getting it. Every task in this state runs on the host with the
  // operator's own credentials, which is the opposite of what the switch says.
  const misleading = enabled && !effective

  return (
    // Same frame every other settings section uses: sections own their padding
    // and column width, the shell only supplies the header and nav.
    <div
      data-slot="isolation-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField
        title="Run agents in a container"
        hint={
          'Each task gets its own container built from this project’s image. The agent sees this repo and '
          + 'nothing else of your machine — not your home directory, not your other repos.'
        }
      >
        <Switch
          checked={enabled}
          disabled={!runtime.ready && !enabled}
          onCheckedChange={(next) => save.mutate(next)}
          aria-label="Run agents in a container"
        />
      </SettingsField>

      {misleading ? (
        <div className="rounded-md border border-danger/50 bg-danger/10 p-3 text-sm">
          <p className="font-medium">Isolation is on, but tasks are running on this machine.</p>
          <p className="mt-1 text-muted-foreground">{runtime.reason}</p>
          {runtime.fix ? (
            <pre className="mt-2 overflow-x-auto rounded bg-background/60 p-2 text-xs">{runtime.fix}</pre>
          ) : null}
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      ) : null}

      <SettingsField title="Container runtime" hint="What this machine can do, regardless of the setting above.">
        <div className="text-sm">
          {runtime.ready ? (
            <p>
              <span className="text-success">Ready</span>
              {' — '}
              {runtime.provider}
              {runtime.version ? ` ${runtime.version}` : ''}
              {runtime.machineName ? `, VM “${runtime.machineName}”` : ''}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">{runtime.reason}</p>
              {runtime.fix ? (
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{runtime.fix}</pre>
              ) : null}
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? 'Checking…' : 'Check again'}
              </Button>
            </>
          )}
        </div>
      </SettingsField>

      {suggestions.length > 0 ? (
        <SettingsField
          title="Tools your agents installed"
          hint={
            'cezar noticed these while tasks ran. Adding them to this project’s Containerfile means the next task '
            + 'starts with them already installed instead of installing them again.'
          }
        >
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-1">
              {suggestions.map((s) => (
                <li key={s.command} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 font-medium uppercase">{s.manager}</span>
                  <code className="break-all">{s.command}</code>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ accept: suggestions.map((s) => s.command) })}
              >
                Add to Containerfile
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ dismiss: suggestions.map((s) => s.command) })}
              >
                Dismiss
              </Button>
            </div>
            {/* Said plainly, because the alternative reading — "nothing happened" — is
                the one a user would otherwise reach when the current task is unaffected. */}
            <p className="text-xs text-muted-foreground">
              The image rebuilds before your next task. The one running now already has these.
            </p>
          </div>
        </SettingsField>
      ) : null}

      <SettingsField
        title="Container resources"
        hint={
          'Limits for each task container. These cap it WITHIN the container VM’s own allocation — on macOS that is '
          + 'not your machine’s total, so raising a limit above what the VM has does nothing.'
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Memory</span>
            <input
              className="w-24 rounded border bg-background px-2 py-1 text-sm"
              defaultValue={resources.memory ?? ''}
              placeholder="VM max"
              aria-label="Container memory limit"
              onBlur={(e) => {
                const value = e.target.value.trim()
                if (value !== (resources.memory ?? '')) saveResources.mutate({ memory: value || null })
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">CPUs</span>
            <input
              className="w-20 rounded border bg-background px-2 py-1 text-sm"
              defaultValue={resources.cpus ?? ''}
              placeholder="VM max"
              inputMode="decimal"
              aria-label="Container CPU limit"
              onBlur={(e) => {
                const raw = e.target.value.trim()
                const value = raw ? Number(raw) : null
                if (value !== null && !Number.isFinite(value)) return
                if (String(value ?? '') !== String(resources.cpus ?? '')) saveResources.mutate({ cpus: value })
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">/dev/shm</span>
            <input
              className="w-24 rounded border bg-background px-2 py-1 text-sm"
              defaultValue={resources.shmSize}
              aria-label="Container shared memory size"
              onBlur={(e) => {
                const value = e.target.value.trim()
                if (value && value !== resources.shmSize) saveResources.mutate({ shmSize: value })
              }}
            />
          </label>
        </div>
        {/* The one people lose a day to: podman's 64m default kills any headless
            browser, and the crash reads as out-of-memory rather than as shared
            memory. Say it here rather than leaving it to be rediscovered. */}
        <p className="mt-2 text-xs text-muted-foreground">
          Chromium and other headless browsers need roughly 1g of <code>/dev/shm</code>; the container default of 64m
          crashes them with what looks like an out-of-memory error.
        </p>
      </SettingsField>

      <SettingsField
        title="Credentials the agent may use"
        hint={
          'An isolated agent starts with none. Each one you add is a deliberate widening — mount for anything the '
          + 'tool refreshes in place, copy for static keys the container should not be able to write back. '
          // Accurate in both directions now: a COPIED credential is added to and
          // removed from running containers as you change it here. A MOUNT
          // cannot be withdrawn from a running container at all, so the one
          // thing still deferred is saying so.
          + 'Copied credentials change in running tasks immediately \u2014 granted or revoked. A mounted one is '
          + 'fixed when a task\u2019s container is created, so revoking it reaches the NEXT task. Anything not set '
          + 'here follows the machine defaults in Settings → Isolation defaults.'
        }
      >
        <CredentialMatrix
          catalog={credentials.catalog}
          value={credentials.enabled}
          busy={saveCredentials.isPending}
          // Only what CHANGED is written. The matrix shows the effective view —
          // machine grants included — and writing that whole map back pinned
          // them into this repo, so revoking one machine-wide did nothing here.
          onChange={(next) => saveCredentials.mutate(changedGrants(credentials.enabled, next))}
        />
      </SettingsField>

      <SettingsField
        title="Secrets from Vault"
        hint={
          'Fetched on this machine when a task\u2019s container starts and injected as environment variables. '
          + 'These are this project\u2019s own \u2014 the machine-wide list in Settings \u2192 Isolation defaults '
          + 'applies to every project that has none.'
        }
      >
        <SecretPicker
          value={(credentials.own.custom ?? []) as SecretEntry[]}
          // Shown, not editable here: they belong to the machine, and editing
          // them from a project would copy them into its config.
          inherited={inheritedSecrets(credentials.custom as SecretEntry[], credentials.own.custom as SecretEntry[])}
          busy={saveSecrets.isPending}
          onChange={(next) => saveSecrets.mutate(next)}
        />
      </SettingsField>

      <SettingsField
        title="Image"
        hint={
          hasContainerfile
            ? 'Built from this project’s Containerfile, once. Tasks start with its toolchain already installed.'
            : 'This project has no Containerfile, so tasks run on the generic base image — enough for Node, git and gh, '
              + 'but not for a toolchain of its own.'
        }
      >
        <code className="text-sm">{image || '—'}</code>
      </SettingsField>
    </div>
  )
}

/**
 * The grants that differ between two views, as a patch.
 *
 * Turning one OFF is written as an explicit `false`, never as a deletion: the
 * grant may be inherited from the machine, and deleting the repo's key would
 * just inherit it back on. `false` is the repo saying "not here".
 */
export function changedGrants(before: Record<string, Choice>, after: Record<string, Choice>): Record<string, Choice> {
  const patch: Record<string, Choice> = {}
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const next = after[id] ?? false
    if (JSON.stringify(before[id] ?? false) !== JSON.stringify(next)) patch[id] = next
  }
  return patch
}

/** Machine-wide secrets this project inherits and has not overridden by id. */
function inheritedSecrets(effective: SecretEntry[], own: SecretEntry[]): SecretEntry[] {
  const mine = new Set(own.map((s) => s.id))
  return effective.filter((s) => !mine.has(s.id))
}
