import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, LinkIcon, UnplugIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { TrackerCandidate, TrackerKind } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { TRACKER_PROVIDERS, trackerProviders } from '@/lib/tracker-providers'
import { clearTrackerAssociation, saveTrackerAssociation, saveTrackerConnection, removeTrackerConnection } from '@/api/client'
import { queryKeys, useTrackerConnection, useTrackerAssociation, useTrackerCandidates, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { LoadingState, RowsSkeleton } from '@/components/loading-state'
import { CardNote, FormRow, SettingsCard } from './form-row'

export function TrackerSection({ providerKind }: { providerKind?: TrackerKind } = {}) {
  const connection = useTrackerConnection()
  const association = useTrackerAssociation()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<TrackerKind>(providerKind ?? 'jira')
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
  const otherProvider = providerKind
    ? currentConnection && currentConnection.kind !== providerKind ? currentConnection.kind
      : savedAssociation && savedAssociation.kind !== providerKind ? savedAssociation.kind : null
    : null
  const scopeConnected = !!savedAssociation && (!providerKind || savedAssociation.kind === providerKind) && (connection.data?.demo === true || (
    !!currentConnection && currentConnection.kind === savedAssociation.kind
    && currentConnection.id === savedAssociation.connectionId
  ))


  if (association.isPending) return <p className="p-6 text-ui text-muted-foreground">Loading tracker settings…</p>
  if (association.isError) return <div className="flex flex-col items-start gap-2 p-6 text-ui text-danger"><p role="alert">{association.error.message}</p><Button variant="outline" size="sm" onClick={() => void association.refetch()}>Retry</Button></div>

  const connected = scopeConnected ? association.data.association : undefined
  const providerLabel = providerKind ? TRACKER_PROVIDERS[providerKind].label : undefined

  return (
    <div className="flex w-full flex-col gap-5" data-slot="tracker-settings">
      <SettingsCard
        title={providerLabel ? `${providerLabel} connection` : 'Issue tracker'}
        description="Connect a project or team from your issue tracker. Credentials belong only to this project and are stored locally outside the repository. Server-wide environment keys are not used."
      >
        <FormRow
          label={connected ? connected.externalName : 'Connected scope'}
          description={
            connected ? (
              <a className="inline-flex items-center gap-1 text-violet hover:underline" href={connected.source.webUrl} target="_blank" rel="noreferrer">
                {TRACKER_PROVIDERS[connected.kind].label} <ExternalLinkIcon className="size-3" />
              </a>
            ) : connection.isPending ? 'Loading connection…' : connection.isError ? 'Connection status unavailable.' : providerLabel ? `${providerLabel} is not connected.` : 'No tracker connected.'
          }
        >
          {connected ? (
            <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              <UnplugIcon className="size-3.5" /> Disconnect
            </Button>
          ) : null}
        </FormRow>
        {providerKind && otherProvider ? (
          <p data-slot="tracker-other-provider" className="px-4 py-2.5 text-meta text-warning">This project currently uses {TRACKER_PROVIDERS[otherProvider].label}. Connecting {providerLabel} replaces the issue source for this project. Test integrations remain unchanged.</p>
        ) : null}
        {savedAssociation && (!providerKind || savedAssociation.kind === providerKind) && currentConnection && !connection.isError && !connection.data?.demo && !scopeConnected ? (
          <CardNote>This scope needs reconnection with this project's credentials. Configure a connection, then browse and select its scope again.</CardNote>
        ) : null}
        {connection.data?.error ? <CardNote tone="danger"><span role="alert">{connection.data.error}</span></CardNote> : null}
        {connection.isError ? (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-meta text-danger">
            Could not load project connection.
            <Button type="button" variant="outline" size="sm" onClick={() => void connection.refetch()}>Retry</Button>
          </div>
        ) : null}
        {!providerKind && <CardNote>For local credential cleanup, run <code>cez tracker-connections list</code>, then <code>cez tracker-connections remove &lt;id&gt;</code>. Local deletion does not revoke the vendor token.</CardNote>}
      </SettingsCard>

      <SettingsCard
        title={providerKind ? 'Configure connection' : 'Connect a provider'}
        action={connection.data?.connection && (!providerKind || connection.data.connection.kind === providerKind) ? (
          <Button variant="outline" size="sm" disabled={credentialBusy} onClick={() => removeCredentials.mutate()}>Remove project credentials</Button>
        ) : null}
      >
        {trackerProviders.filter(provider => !providerKind || provider.kind === providerKind).map((provider) => {
          const ready = !connection.isError && (connection.data?.demo === true || connection.data?.connection?.kind === provider.kind)
          return (
            <FormRow
              key={provider.kind}
              label={provider.label}
              description={ready ? undefined : 'Configure credentials for this project to browse.'}
            >
              {!connection.data?.demo ? (
                <Button variant="outline" size="sm" disabled={credentialBusy || connection.isPending || connection.isError} onClick={() => { resetSecrets(); setCredentialKind(provider.kind); setPickerOpen(false); setSelected(null) }}>
                  {connection.data?.connection?.kind === provider.kind ? 'Replace' : 'Configure'} {provider.label} credentials
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={!ready || credentialBusy}
                onClick={() => { setKind(provider.kind); setPickerOpen(true); setSearch(''); setSelected(null) }}
              >
                <LinkIcon className="size-3.5" /> Browse {provider.label}
              </Button>
            </FormRow>
          )
        })}
      </SettingsCard>

      {credentialKind ? (
        <form onSubmit={event => { event.preventDefault(); saveCredentials.mutate() }} autoComplete="off">
          <SettingsCard
            title={`${TRACKER_PROVIDERS[credentialKind].label} credentials for this project`}
            description="Saved in a private .env file for this project, without encryption. Use read-only access limited to this project's data. Saving replaces this project's connection and requires selecting its scope again."
          >
            {credentialKind === 'jira' ? <>
              <FormRow htmlFor="tracker-jira-origin" label="Jira site URL">
                <Input id="tracker-jira-origin" aria-label="Jira site URL" type="url" required value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://your-site.atlassian.net" className="h-8 w-72 max-w-full" />
              </FormRow>
              <FormRow htmlFor="tracker-jira-email" label="Account email">
                <Input id="tracker-jira-email" aria-label="Account email" type="email" required value={email} onChange={event => setEmail(event.target.value)} className="h-8 w-72 max-w-full" />
              </FormRow>
            </> : null}
            <FormRow htmlFor="tracker-token" label="API token">
              <Input id="tracker-token" aria-label="API token" type="password" autoComplete="new-password" required maxLength={8192} value={secret} onChange={event => setSecret(event.target.value)} className="h-8 w-72 max-w-full" />
            </FormRow>
            <div className="flex gap-2 px-4 py-3">
              <Button type="button" variant="outline" size="sm" disabled={credentialBusy} onClick={resetSecrets}>Cancel</Button>
              <Button type="submit" size="sm" disabled={credentialBusy}>Save project credentials</Button>
            </div>
          </SettingsCard>
        </form>
      ) : null}

      {pickerOpen ? (
        <section className="rounded-[10px] border border-violet/40 bg-card p-4" aria-label={`${TRACKER_PROVIDERS[kind].label} picker`}>
          <label className="text-label font-medium" htmlFor="tracker-candidate-search">Search {TRACKER_PROVIDERS[kind].scopeLabel}</label>
          <Input
            id="tracker-candidate-search"
            className="mt-2"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setSelected(null) }}
            placeholder="Search by name…"
          />
          <div className="mt-3 max-h-64 space-y-1 overflow-auto">
            {candidates.isPending ? <LoadingState label="Loading candidates…"><RowsSkeleton rows={3} /></LoadingState> : null}
            {candidates.isError ? <CandidateFailure reason={candidates.error.message} generation={candidates.errorUpdatedAt} retry={() => void candidates.refetch()} /> : null}
            {candidateFailure && !candidateFailure.available ? <CandidateFailure reason={candidateFailure.reason} generation={candidates.dataUpdatedAt} retryAfterSeconds={candidateFailure.code === 'rate_limited' ? candidateFailure.retryAfterSeconds : undefined} retry={() => void candidates.refetch()} /> : null}
            {options.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`block w-full rounded-md border px-3 py-2 text-left text-ui ${selected?.id === candidate.id ? 'border-violet bg-violet/10' : 'border-border'}`}
                onClick={() => setSelected(candidate)}
              >{candidate.name}</button>
            ))}
            {!candidates.isPending && !candidates.isError && !candidateFailure && options.length === 0 ? <p className="py-3 text-ui text-muted-foreground">No projects or teams match.</p> : null}
            {candidates.hasNextPage ? (
              <Button variant="ghost" size="sm" onClick={() => void candidates.fetchNextPage()} disabled={candidates.isFetchingNextPage}>Load more</Button>
            ) : null}
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>Cancel</Button>
            <Button variant="contrast" size="sm" disabled={!selected || connect.isPending || credentialBusy} onClick={() => connect.mutate()}>Connect</Button>
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
  return <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-ui"><p className="text-danger">{reason}</p><Button className="mt-2" variant="outline" size="sm" disabled={cooldown > 0} onClick={retry}>{cooldown > 0 ? `Retry in ${cooldown}s` : 'Retry'}</Button></div>
}
