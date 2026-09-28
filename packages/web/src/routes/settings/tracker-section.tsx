import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, LinkIcon, UnplugIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { TrackerCandidate, TrackerKind } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { TRACKER_PROVIDERS, trackerProviders } from '@/lib/tracker-providers'
import { clearTrackerAssociation, saveTrackerAssociation, saveTrackerConnection, removeTrackerConnection } from '@/api/client'
import { queryKeys, useTrackerConnection, useTrackerAssociation, useTrackerCandidates, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

export function TrackerSection() {
  const connection = useTrackerConnection()
  const association = useTrackerAssociation()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<TrackerKind>('jira')
  const [credentialKind, setCredentialKind] = useState<TrackerKind | null>(null)
  const [origin, setOrigin] = useState('')
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  const resetSecrets = () => { setSecret(''); setEmail(''); setOrigin(''); setCredentialKind(null) }
  const activeProject = queryScope()
  useEffect(() => { resetSecrets(); setPickerOpen(false); setSelected(null) }, [activeProject])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<TrackerCandidate | null>(null)
  const candidates = useTrackerCandidates(kind, search, pickerOpen)
  const pages = candidates.data?.pages ?? []
  const source = pages.find((page) => page.available)?.available
    ? pages.find((page) => page.available)!.source
    : undefined
  const options = useMemo(
    () => pages.flatMap((page) => page.available ? page.candidates : []),
    [pages],
  )
  useEffect(() => { setPickerOpen(false); setSelected(null); resetSecrets() }, [connection.data?.connection?.id])
  const candidateFailure = pages.find((page) => !page.available)

  const refresh = async (projectId: string) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.tracker.allFor(projectId) })
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
  }
  const connect = useMutation({
    mutationFn: async () => {
      if (!selected || !source) throw new Error('Choose a tracker project first.')
      const projectId = queryScope()
      const associationKey = queryKeys.tracker.associationFor(projectId)
      const result = await saveTrackerAssociation({ kind, sourceId: source.id, externalId: selected.id, ...(connection.data?.connection ? { connectionId: connection.data.connection.id } : {}) })
      return { ...result, projectId, associationKey }
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.tracker.allFor(result.projectId) }),
        queryClient.cancelQueries({ queryKey: workspaceQueryKeys.projects }),
      ])
      queryClient.setQueryData(result.associationKey, { association: result.association })
      setPickerOpen(false)
      setSelected(null)
      await refresh(result.projectId)
      toast(`${result.association.externalName} connected`)
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const disconnect = useMutation({
    mutationFn: async () => {
      const projectId = queryScope()
      const associationKey = queryKeys.tracker.associationFor(projectId)
      const result = await clearTrackerAssociation()
      return { ...result, projectId, associationKey }
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.tracker.allFor(result.projectId) }),
        queryClient.cancelQueries({ queryKey: workspaceQueryKeys.projects }),
      ])
      queryClient.setQueryData(result.associationKey, { association: null })
      await refresh(result.projectId)
      toast('Tracker disconnected')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const saveCredentials = useMutation({
    onMutate: () => queryScope(),
    mutationFn: async () => {
      const projectId = queryScope()
      if (!credentialKind) throw new Error('Choose a provider.')
      const result = await saveTrackerConnection(credentialKind === 'jira'
        ? { kind: 'jira', origin: origin.trim(), email: email.trim(), token: secret }
        : { kind: 'linear', key: secret })
      return { ...result, projectId }
    },
    onSuccess: async result => {
      if (queryScope() === result.projectId) { resetSecrets(); setPickerOpen(false); setSelected(null) }
      await queryClient.cancelQueries({ queryKey: queryKeys.tracker.allFor(result.projectId) })
      queryClient.setQueryData(['tracker', result.projectId, 'connection'], { connection: result.connection, demo: result.demo })
      await refresh(result.projectId)
      toast('Credentials saved for this project. Browse and connect a scope.')
    },
    onError: (error: Error, _variables, projectId) => { if (queryScope() === projectId) setSecret(''); toast(error.message, { tone: 'danger' }) },
  })
  const removeCredentials = useMutation({
    mutationFn: async () => { const projectId = queryScope(); await removeTrackerConnection(); return projectId },
    onSuccess: async projectId => {
      if (queryScope() === projectId) { resetSecrets(); setPickerOpen(false); setSelected(null) }
      await queryClient.cancelQueries({ queryKey: queryKeys.tracker.allFor(projectId) })
      queryClient.setQueryData(['tracker', projectId, 'connection'], { connection: null, demo: false })
      await refresh(projectId)
      toast('Project credentials removed')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const credentialBusy = saveCredentials.isPending || removeCredentials.isPending
  const savedAssociation = association.data?.association
  const currentConnection = connection.data?.connection
  const scopeConnected = !!savedAssociation && (connection.data?.demo === true || (
    !!currentConnection && currentConnection.kind === savedAssociation.kind
    && currentConnection.id === savedAssociation.connectionId
  ))


  if (association.isPending) return <p className="p-6 text-sm text-muted-foreground">Loading tracker settings…</p>
  if (association.isError) return <p className="p-6 text-sm text-danger">{association.error.message}</p>

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6" data-slot="tracker-settings">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Issue tracker</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a project or team from your issue tracker. Credentials belong only to this project and are stored locally outside the repository. Server-wide environment keys are not used.
        </p>
        {scopeConnected && association.data.association ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
            <div>
              <p className="font-medium">{association.data.association.externalName}</p>
              <a className="inline-flex items-center gap-1 text-xs text-violet hover:underline" href={association.data.association.source.webUrl} target="_blank" rel="noreferrer">
                {TRACKER_PROVIDERS[association.data.association.kind].label} <ExternalLinkIcon className="size-3" />
              </a>
            </div>
            <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              <UnplugIcon className="size-3.5" /> Disconnect
            </Button>
          </div>
        ) : <p className="mt-4 text-sm font-medium">{connection.isPending ? 'Loading connection…' : connection.isError ? 'Connection status unavailable.' : 'No tracker connected.'}</p>}
      </section>

      {savedAssociation && currentConnection && !connection.isError && !connection.data?.demo && !scopeConnected ? <p className="text-sm text-warning">This scope needs reconnection with this project's credentials. Configure a connection, then browse and select its scope again.</p> : null}
      {connection.data?.error ? <p role="alert" className="text-sm text-danger">{connection.data.error}</p> : null}
      <p className="text-xs text-muted-foreground">For local credential cleanup, run <code>cez tracker-connections list</code>, then <code>cez tracker-connections remove &lt;id&gt;</code>. Local deletion does not revoke the vendor token.</p>
      {connection.isError ? <p className="text-sm text-danger">Could not load project connection. <button onClick={() => void connection.refetch()}>Retry</button></p> : null}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Connect a provider</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {trackerProviders.map((provider) => {
            const ready = !connection.isError && (connection.data?.demo === true || connection.data?.connection?.kind === provider.kind)
            return (
              <div key={provider.kind} className="rounded-md border border-border p-3">
                <p className="font-medium">{provider.label}</p>
                {!connection.data?.demo ? <Button variant="outline" disabled={credentialBusy || connection.isPending || connection.isError} onClick={() => { resetSecrets(); setCredentialKind(provider.kind); setPickerOpen(false); setSelected(null) }}>
                  {connection.data?.connection?.kind === provider.kind ? 'Replace' : 'Configure'} {provider.label} credentials
                </Button> : null}
                <Button
                  className="mt-3"
                  variant="outline"
                  disabled={!ready || credentialBusy}
                  onClick={() => { setKind(provider.kind); setPickerOpen(true); setSearch(''); setSelected(null) }}
                >
                  <LinkIcon className="size-3.5" /> Browse {provider.label}
                </Button>
                {!ready ? <p className="mt-2 text-xs text-muted-foreground">Configure credentials for this project to browse.</p> : null}
              </div>
            )
          })}
        </div>
      </section>

      {connection.data?.connection ? <Button variant="outline" disabled={credentialBusy} onClick={() => removeCredentials.mutate()}>Remove project credentials</Button> : null}
      {credentialKind ? (
        <form className="rounded-lg border border-border bg-card p-4" onSubmit={event => { event.preventDefault(); saveCredentials.mutate() }} autoComplete="off">
          <h2 className="font-medium">{TRACKER_PROVIDERS[credentialKind].label} credentials for this project</h2>
          <p className="mt-2 text-xs text-muted-foreground">Saved in a private .env file for this project, without encryption. Use read-only access limited to this project's data. Saving replaces this project's connection and requires selecting its scope again.</p>
          {credentialKind === 'jira' ? <>
            <label className="mt-3 block text-sm">Jira site URL<input aria-label="Jira site URL" type="url" required value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://your-site.atlassian.net" className="mt-1 block w-full rounded border bg-background p-2" /></label>
            <label className="mt-3 block text-sm">Account email<input aria-label="Account email" type="email" required value={email} onChange={event => setEmail(event.target.value)} className="mt-1 block w-full rounded border bg-background p-2" /></label>
          </> : null}
          <label className="mt-3 block text-sm">API token<input aria-label="API token" type="password" autoComplete="new-password" required maxLength={8192} value={secret} onChange={event => setSecret(event.target.value)} className="mt-1 block w-full rounded border bg-background p-2" /></label>
          <div className="mt-3 flex gap-2"><Button type="submit" disabled={credentialBusy}>Save project credentials</Button><Button type="button" variant="outline" disabled={credentialBusy} onClick={resetSecrets}>Cancel</Button></div>
        </form>
      ) : null}

      {pickerOpen ? (
        <section className="rounded-lg border border-violet/40 bg-card p-4" aria-label={`${TRACKER_PROVIDERS[kind].label} picker`}>
          <label className="text-xs font-medium" htmlFor="tracker-candidate-search">Search {TRACKER_PROVIDERS[kind].scopeLabel}</label>
          <input
            id="tracker-candidate-search"
            className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setSelected(null) }}
            placeholder="Search by name…"
          />
          <div className="mt-3 max-h-64 space-y-1 overflow-auto">
            {candidates.isPending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {candidates.isError ? <CandidateFailure reason={candidates.error.message} generation={candidates.errorUpdatedAt} retry={() => void candidates.refetch()} /> : null}
            {candidateFailure && !candidateFailure.available ? <CandidateFailure reason={candidateFailure.reason} generation={candidates.dataUpdatedAt} retryAfterSeconds={candidateFailure.code === 'rate_limited' ? candidateFailure.retryAfterSeconds : undefined} retry={() => void candidates.refetch()} /> : null}
            {options.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`block w-full rounded-md border px-3 py-2 text-left text-sm ${selected?.id === candidate.id ? 'border-violet bg-violet/10' : 'border-border'}`}
                onClick={() => setSelected(candidate)}
              >{candidate.name}</button>
            ))}
            {!candidates.isPending && !candidates.isError && !candidateFailure && options.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No projects or teams match.</p> : null}
            {candidates.hasNextPage ? (
              <Button variant="ghost" onClick={() => void candidates.fetchNextPage()} disabled={candidates.isFetchingNextPage}>Load more</Button>
            ) : null}
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="contrast" disabled={!selected || connect.isPending || credentialBusy} onClick={() => connect.mutate()}>Connect</Button>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>Cancel</Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function CandidateFailure({ reason, retry, retryAfterSeconds = 0, generation }: { reason: string; retry: () => void; retryAfterSeconds?: number; generation: number }) {
  const [cooldown, setCooldown] = useState(retryAfterSeconds)
  useEffect(() => setCooldown(retryAfterSeconds), [reason, retryAfterSeconds, generation])
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [cooldown > 0])
  return <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-sm"><p className="text-danger">{reason}</p><Button className="mt-2" variant="outline" disabled={cooldown > 0} onClick={retry}>{cooldown > 0 ? `Retry in ${cooldown}s` : 'Retry'}</Button></div>
}
