import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ExternalLinkIcon, KeyRoundIcon, LinkIcon, SearchIcon, TicketIcon, TriangleAlertIcon, UnplugIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { TrackerCandidate, TrackerKind } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { TRACKER_PROVIDERS, trackerProviders } from '@/lib/tracker-providers'
import { clearTrackerAssociation, saveTrackerAssociation, saveTrackerConnection, removeTrackerConnection } from '@/api/client'
import { queryKeys, useTrackerConnection, useTrackerAssociation, useTrackerCandidates, workspaceQueryKeys } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { cn } from '@/lib/utils'
import {
  DangerZone,
  SettingsError,
  SettingsField,
  SettingsGroup,
  SettingsLoading,
  SettingsNote,
  SettingsPane,
} from './settings-field'
import { Toggle } from '@/components/ui/toggle'
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


  if (association.isPending) return <SettingsLoading label="Loading tracker settings…" />
  if (association.isError) {
    return <SettingsError title="Tracker settings did not load">{association.error.message}</SettingsError>
  }

  const needsReconnect =
    savedAssociation && currentConnection && !connection.isError && !connection.data?.demo && !scopeConnected

  return (
    <SettingsPane data-slot="tracker-settings">
      <SettingsGroup
        title="Connection"
        description="Connect a project or team from your issue tracker. Credentials belong only to this project and are stored locally outside the repository. Server-wide environment keys are not used."
      >
        {scopeConnected && association.data.association ? (
          <Item size="sm" className="rounded-none px-5 py-4">
            <ItemMedia variant="icon">
              <TicketIcon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {association.data.association.externalName}
                <Badge variant="outline" className="gap-1.5 font-normal">
                  <StatusDot tone="success" />
                  Connected
                </Badge>
              </ItemTitle>
              <ItemDescription>
                <a
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  href={association.data.association.source.webUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {TRACKER_PROVIDERS[association.data.association.kind].label} <ExternalLinkIcon className="size-3" />
                </a>
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                <UnplugIcon className="size-3.5" /> Disconnect
              </Button>
            </ItemActions>
          </Item>
        ) : (
          <Item size="sm" className="rounded-none px-5 py-4">
            <ItemMedia variant="icon">
              <TicketIcon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {connection.isPending ? 'Loading connection…' : connection.isError ? 'Connection status unavailable.' : 'No tracker connected.'}
              </ItemTitle>
              <ItemDescription>Configure a provider below, then browse and connect a scope.</ItemDescription>
            </ItemContent>
          </Item>
        )}
      </SettingsGroup>

      {needsReconnect ? (
        <Alert>
          <TriangleAlertIcon aria-hidden="true" className="text-pending-strong" />
          <AlertDescription>
            This scope needs reconnection with this project's credentials. Configure a connection, then browse and select its scope again.
          </AlertDescription>
        </Alert>
      ) : null}
      {connection.data?.error ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{connection.data.error}</AlertDescription>
        </Alert>
      ) : null}
      {connection.isError ? (
        <SettingsError
          title="Could not load project connection."
          action={<Button variant="outline" size="sm" onClick={() => void connection.refetch()}>Retry</Button>}
        />
      ) : null}

      <SettingsGroup title="Connect a provider">
        {trackerProviders.map((provider) => {
          const ready = !connection.isError && (connection.data?.demo === true || connection.data?.connection?.kind === provider.kind)
          return (
            <Item key={provider.kind} size="sm" className="rounded-none px-5 py-4">
              <ItemContent>
                <ItemTitle>{provider.label}</ItemTitle>
                {!ready ? <ItemDescription>Configure credentials for this project to browse.</ItemDescription> : null}
              </ItemContent>
              <ItemActions className="flex-wrap">
                {!connection.data?.demo ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={credentialBusy || connection.isPending || connection.isError}
                    aria-label={`${connection.data?.connection?.kind === provider.kind ? 'Replace' : 'Configure'} ${provider.label} credentials`}
                    onClick={() => { resetSecrets(); setCredentialKind(provider.kind); setPickerOpen(false); setSelected(null) }}
                  >
                    <KeyRoundIcon className="size-3.5" />
                    {connection.data?.connection?.kind === provider.kind ? 'Replace' : 'Configure'} credentials
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
              </ItemActions>
            </Item>
          )
        })}
      </SettingsGroup>

      {credentialKind ? (
        <SettingsGroup
          title={`${TRACKER_PROVIDERS[credentialKind].label} credentials for this project`}
          description="Saved in a private .env file for this project, without encryption. Use read-only access limited to this project's data. Saving replaces this project's connection and requires selecting its scope again."
        >
          <form className="px-5 py-5" onSubmit={event => { event.preventDefault(); saveCredentials.mutate() }} autoComplete="off">
            <FieldGroup className="gap-5">
              {credentialKind === 'jira' ? <>
                <Field>
                  <FieldLabel htmlFor="tracker-origin">Jira site URL</FieldLabel>
                  <Input id="tracker-origin" aria-label="Jira site URL" type="url" required value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://your-site.atlassian.net" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tracker-email">Account email</FieldLabel>
                  <Input id="tracker-email" aria-label="Account email" type="email" required value={email} onChange={event => setEmail(event.target.value)} />
                </Field>
              </> : null}
              <Field>
                <FieldLabel htmlFor="tracker-token">API token</FieldLabel>
                <Input id="tracker-token" aria-label="API token" type="password" autoComplete="new-password" required maxLength={8192} value={secret} onChange={event => setSecret(event.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="default" disabled={credentialBusy}>Save project credentials</Button>
                <Button type="button" variant="ghost" disabled={credentialBusy} onClick={resetSecrets}>Cancel</Button>
              </div>
            </FieldGroup>
          </form>
        </SettingsGroup>
      ) : null}

      {pickerOpen ? (
        <SettingsGroup title={`Browse ${TRACKER_PROVIDERS[kind].label}`}>
          <section className="flex flex-col gap-3 px-5 py-5" aria-label={`${TRACKER_PROVIDERS[kind].label} picker`}>
            <Field>
              <FieldLabel htmlFor="tracker-candidate-search">Search {TRACKER_PROVIDERS[kind].scopeLabel}</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="tracker-candidate-search"
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setSelected(null) }}
                  placeholder="Search by name…"
                />
              </InputGroup>
            </Field>
            <div className="max-h-64 space-y-1 overflow-auto">
              {candidates.isPending ? <p className="py-2 text-sm text-muted-foreground">Loading…</p> : null}
              {candidates.isError ? <CandidateFailure reason={candidates.error.message} generation={candidates.errorUpdatedAt} retry={() => void candidates.refetch()} /> : null}
              {candidateFailure && !candidateFailure.available ? <CandidateFailure reason={candidateFailure.reason} generation={candidates.dataUpdatedAt} retryAfterSeconds={candidateFailure.code === 'rate_limited' ? candidateFailure.retryAfterSeconds : undefined} retry={() => void candidates.refetch()} /> : null}
              {options.map((candidate) => (
                <Toggle
                  key={candidate.id}
                  pressed={selected?.id === candidate.id}
                  // A pick, not an on/off switch: pressing the chosen row again keeps it chosen.
                  onPressedChange={() => setSelected(candidate)}
                  className="flex h-auto w-full justify-between gap-2 px-3 py-2 text-left text-sm font-normal whitespace-normal text-foreground hover:bg-muted/60 hover:text-foreground data-[state=on]:bg-muted data-[state=on]:font-medium data-[state=on]:text-foreground"
                >
                  {candidate.name}
                  {selected?.id === candidate.id ? <CheckIcon aria-hidden="true" className="size-4" /> : null}
                </Toggle>
              ))}
              {!candidates.isPending && !candidates.isError && !candidateFailure && options.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No projects or teams match.</p> : null}
              {candidates.hasNextPage ? (
                <Button variant="ghost" size="sm" onClick={() => void candidates.fetchNextPage()} disabled={candidates.isFetchingNextPage}>Load more</Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="default" disabled={!selected || connect.isPending || credentialBusy} onClick={() => connect.mutate()}>Connect</Button>
              <Button variant="ghost" onClick={() => setPickerOpen(false)}>Cancel</Button>
            </div>
          </section>
        </SettingsGroup>
      ) : null}

      {connection.data?.connection ? (
        <DangerZone title="Credentials">
          <SettingsField
            title="Remove project credentials"
            hint={
              <>
                For local credential cleanup, run <Code>cez tracker-connections list</Code>, then{' '}
                <Code>cez tracker-connections remove &lt;id&gt;</Code>. Local deletion does not revoke the vendor token.
              </>
            }
            control={
              <Button variant="destructive" size="sm" disabled={credentialBusy} onClick={() => removeCredentials.mutate()}>
                Remove project credentials
              </Button>
            }
          />
        </DangerZone>
      ) : (
        <SettingsNote>
          For local credential cleanup, run <Code>cez tracker-connections list</Code>, then{' '}
          <Code>cez tracker-connections remove &lt;id&gt;</Code>. Local deletion does not revoke the vendor token.
        </SettingsNote>
      )}
    </SettingsPane>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{children}</code>
}

function CandidateFailure({ reason, retry, retryAfterSeconds = 0, generation }: { reason: string; retry: () => void; retryAfterSeconds?: number; generation: number }) {
  const [cooldown, setCooldown] = useState(retryAfterSeconds)
  useEffect(() => setCooldown(retryAfterSeconds), [reason, retryAfterSeconds, generation])
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [cooldown > 0])
  return (
    <SettingsError
      title={reason}
      action={
        <Button variant="outline" size="sm" disabled={cooldown > 0} onClick={retry}>
          {cooldown > 0 ? `Retry in ${cooldown}s` : 'Retry'}
        </Button>
      }
    />
  )
}
