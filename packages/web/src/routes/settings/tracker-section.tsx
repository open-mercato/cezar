import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, LinkIcon, UnplugIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { TrackerCandidate, TrackerConnection, TrackerKind, TrackerSharedConnection } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { TRACKER_PROVIDERS, trackerProviders } from '@/lib/tracker-providers'
import { clearTrackerAssociation, linkTrackerSharedConnection, promoteTrackerConnection, saveTrackerAssociation, saveTrackerConnection, removeTrackerConnection } from '@/api/client'
import { queryKeys, useTrackerConnection, useTrackerAssociation, useTrackerCandidates, useTrackerSharedConnections, workspaceQueryKeys } from '@/api/queries'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { LoadingState, RowsSkeleton } from '@/components/loading-state'
import { CardNote, FormRow, SettingsCard } from './form-row'

export function TrackerSection() {
  const connection = useTrackerConnection()
  const association = useTrackerAssociation()
  const sharedConnections = useTrackerSharedConnections(connection.data?.demo === false)
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<TrackerKind>('jira')
  const [credentialKind, setCredentialKind] = useState<TrackerKind | null>(null)
  const [origin, setOrigin] = useState('')
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  // Spec 2026-11-18-shared-tracker-connections: checked (project-only) is today's behaviour.
  const [projectOnly, setProjectOnly] = useState(true)
  const resetSecrets = () => { setSecret(''); setEmail(''); setOrigin(''); setCredentialKind(null); setProjectOnly(true) }
  const activeProject = queryScope()
  useEffect(() => { resetSecrets(); setPickerOpen(false); setSelected(null) }, [activeProject])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [replacing, setReplacing] = useState<TrackerSharedConnection | null>(null)
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
    // Every project's shared list: a save, share or pick here changes what the others can pick.
    await queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === 'tracker' && query.queryKey[2] === 'shared-connections' })
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
      const shared = projectOnly ? {} : { shared: true }
      const result = await saveTrackerConnection(credentialKind === 'jira'
        ? { kind: 'jira', origin: origin.trim(), email: email.trim(), token: secret, ...shared }
        : { kind: 'linear', key: secret, ...shared })
      return { ...result, projectId }
    },
    onSuccess: async result => {
      if (queryScope() === result.projectId) { resetSecrets(); setPickerOpen(false); setSelected(null) }
      await settleConnection(result.projectId, result)
      toast(result.connection?.shared
        ? 'Credentials saved as a shared connection. Browse and connect a scope.'
        : 'Credentials saved for this project. Browse and connect a scope.')
    },
    onError: (error: Error, _variables, projectId) => { if (queryScope() === projectId) setSecret(''); toast(error.message, { tone: 'danger' }) },
  })
  const settleConnection = async (projectId: string, result: { connection: TrackerConnection | null; demo: boolean }) => {
    await queryClient.cancelQueries({ queryKey: queryKeys.tracker.allFor(projectId) })
    queryClient.setQueryData(['tracker', projectId, 'connection'], { connection: result.connection, demo: result.demo })
    await refresh(projectId)
  }
  const pickShared = useMutation({
    mutationFn: async (id: string) => { const projectId = queryScope(); return { ...await linkTrackerSharedConnection(id), projectId } },
    onSuccess: async result => {
      if (queryScope() === result.projectId) { resetSecrets(); setPickerOpen(false); setSelected(null) }
      await settleConnection(result.projectId, result)
      toast('Using the shared connection. Browse and connect a scope.')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const promote = useMutation({
    mutationFn: async () => { const projectId = queryScope(); return { ...await promoteTrackerConnection(), projectId } },
    onSuccess: async result => {
      await settleConnection(result.projectId, result)
      toast('These credentials are now a shared connection other projects can pick.')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const removeCredentials = useMutation({
    mutationFn: async () => { const projectId = queryScope(); const wasShared = shared; await removeTrackerConnection(); return { projectId, wasShared } },
    onSuccess: async ({ projectId, wasShared }) => {
      if (queryScope() === projectId) { resetSecrets(); setPickerOpen(false); setSelected(null) }
      await queryClient.cancelQueries({ queryKey: queryKeys.tracker.allFor(projectId) })
      queryClient.setQueryData(['tracker', projectId, 'connection'], { connection: null, demo: false })
      await refresh(projectId)
      toast(wasShared ? 'This project no longer uses the shared connection' : 'Project credentials removed')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const credentialBusy = saveCredentials.isPending || removeCredentials.isPending || pickShared.isPending || promote.isPending
  const shared = connection.data?.connection?.shared === true
  const pickable = (sharedConnections.data?.connections ?? []).filter(item => !item.current)
  const savedAssociation = association.data?.association
  const currentConnection = connection.data?.connection
  const scopeConnected = !!savedAssociation && (connection.data?.demo === true || (
    !!currentConnection && currentConnection.kind === savedAssociation.kind
    && currentConnection.id === savedAssociation.connectionId
  ))


  if (association.isPending) return <p className="p-6 text-ui text-muted-foreground">Loading tracker settings…</p>
  if (association.isError) return <p className="p-6 text-ui text-danger">{association.error.message}</p>

  const connected = scopeConnected ? association.data.association : undefined

  return (
    <div className="flex w-full flex-col gap-5" data-slot="tracker-settings">
      <SettingsCard
        title="Issue tracker"
        description="Connect a project or team from your issue tracker. Credentials belong to this project unless you share them, and are stored encrypted outside the repository. Server-wide environment keys are not used."
      >
        <FormRow
          label={connected ? connected.externalName : 'Connected scope'}
          description={
            connected ? (
              <a className="inline-flex items-center gap-1 text-violet hover:underline" href={connected.source.webUrl} target="_blank" rel="noreferrer">
                {TRACKER_PROVIDERS[connected.kind].label} <ExternalLinkIcon className="size-3" />
              </a>
            ) : connection.isPending ? 'Loading connection…' : connection.isError ? 'Connection status unavailable.' : 'No tracker connected.'
          }
        >
          {connected ? (
            <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              <UnplugIcon className="size-3.5" /> Disconnect
            </Button>
          ) : null}
        </FormRow>
        {savedAssociation && currentConnection && !connection.isError && !connection.data?.demo && !scopeConnected ? (
          <CardNote>This scope needs reconnection with this project's credentials. Configure a connection, then browse and select its scope again.</CardNote>
        ) : null}
        {connection.data?.error ? <CardNote tone="danger"><span role="alert">{connection.data.error}</span></CardNote> : null}
        {connection.isError ? (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-meta text-danger">
            Could not load project connection.
            <Button type="button" variant="outline" size="sm" onClick={() => void connection.refetch()}>Retry</Button>
          </div>
        ) : null}
        {shared ? <CardNote>This project uses a shared connection. Other projects that picked it use the same credentials.</CardNote> : null}
        <CardNote>For local credential cleanup, run <code>cez tracker-connections list</code>, then <code>cez tracker-connections remove &lt;id&gt;</code> (a shared connection's id is <code>shared-&lt;uuid&gt;</code>). Local deletion does not revoke the vendor token.</CardNote>
      </SettingsCard>

      <SettingsCard
        title="Connect a provider"
        action={connection.data?.connection ? (
          <div className="flex flex-wrap gap-2">
            {!shared ? <Button variant="outline" size="sm" disabled={credentialBusy} onClick={() => promote.mutate()}>Share with other projects</Button> : null}
            <Button variant="outline" size="sm" disabled={credentialBusy} onClick={() => removeCredentials.mutate()}>{shared ? 'Stop using shared connection' : 'Remove project credentials'}</Button>
          </div>
        ) : null}
      >
        {trackerProviders.map((provider) => {
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

      {!connection.data?.demo && pickable.length > 0 ? (
        <SettingsCard
          title="Use a shared connection"
          description="Credentials saved for other projects too. Using one replaces this project's own credentials; then browse and connect a scope."
        >
          {pickable.map(item => (
            <FormRow key={item.id} label={item.label} description={TRACKER_PROVIDERS[item.kind].label}>
              <Button variant="outline" size="sm" aria-label={`Use ${item.label}`} disabled={credentialBusy || connection.isPending || connection.isError} onClick={() => {
                // Using one deletes this project's own credentials; shared ones are only unlinked.
                if (connection.data?.connection && !shared) setReplacing(item)
                else pickShared.mutate(item.id)
              }}>Use</Button>
            </FormRow>
          ))}
        </SettingsCard>
      ) : null}

      <AlertDialog open={replacing !== null} onOpenChange={open => { if (!open) setReplacing(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this project's credentials?</AlertDialogTitle>
            <AlertDialogDescription>
              This project's own credentials are deleted and it uses {replacing?.label} instead. Connect its scope again afterwards. The vendor token is not revoked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (replacing) pickShared.mutate(replacing.id); setReplacing(null) }}>Use shared connection</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {credentialKind ? (
        <form onSubmit={event => { event.preventDefault(); saveCredentials.mutate() }} autoComplete="off">
          <SettingsCard
            title={`${TRACKER_PROVIDERS[credentialKind].label} credentials for this project`}
            description="Encrypted and stored outside the repository. Use read-only access limited to the data you need. Saving replaces this project's connection and requires selecting its scope again."
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
            <label className="flex items-start gap-2 px-4 py-2.5 text-ui">
              <input type="checkbox" className="mt-0.5" checked={projectOnly} onChange={event => setProjectOnly(event.target.checked)} />
              <span>Visible only for this project<span className="block text-meta text-muted-foreground">Uncheck to save these credentials as a shared connection other projects can pick. No other project uses them until you pick them there.</span></span>
            </label>
            <div className="flex gap-2 px-4 py-3">
              <Button type="button" variant="outline" size="sm" disabled={credentialBusy} onClick={resetSecrets}>Cancel</Button>
              <Button type="submit" size="sm" disabled={credentialBusy}>{projectOnly ? 'Save project credentials' : 'Save shared credentials'}</Button>
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
