import { ChatSelection } from './chat-selection'
import { useHealth, useProjects } from '@/api/queries'
import { pathnameProjectId } from '@/lib/project-router'
import { settingsReturnLocation } from '@/lib/settings-return'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderBrowser } from '@/components/folder-browser'
import { ExtensionFormView } from '@/components/extensions/form'
import { useEffect, useRef, useState } from 'react'
import type { ExtensionInventoryItem, ExtensionUninstallImpact, ExtensionManifest, ExtensionRecord, FsBrowseDir } from '@open-mercato/cezar-api-client'
import { listExtensionInventory, loadUninstallImpact, prepareExtensionUpdate, loadExtensionForms, commitExtension, enableExtension, extensionKeys, listExtensions, loadExtensionPanel, prepareExtension, runExtensionCommand, uninstallExtension } from '@/api/extensions'
import { ExtensionPanelView } from '@/components/extensions/panel'
import { ExtensionCommandOutcome, useExtensionCommandResult, type ExtensionCommandOutcomeValue as CommandOutcomeValue } from '@/components/extensions/command-outcome'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FormRow, SettingsCard } from './form-row'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Link, useSearchParams } from 'react-router'
import { LoadingState, RowsSkeleton } from '@/components/loading-state'

/** Settings shows only Settings-located contributions; palette/sidebar/task ones render in their own
 *  surfaces (spec 2026-11-07-extension-placements) and a task panel needs a runId anyway. */
const inSettings = (item: { location?: string }) => (item.location ?? 'settings') === 'settings'

export function PermissionPreview({ manifest }: { manifest: ExtensionManifest }) {
  const commands = manifest.contributes?.commands ?? []
  const panels = manifest.contributes?.panels ?? []
  const forms = manifest.contributes?.forms ?? []
  const chatProviders = manifest.contributes?.chatProviders ?? []
  const contributions = [[commands.length, 'command'], [panels.length, 'panel'], [forms.length, 'form'], [chatProviders.length, 'chat provider']] as const
  return <div className="flex flex-col gap-2 text-sm">
    <p>{manifest.name} · {manifest.version}</p>
    <p>Capabilities: {manifest.capabilities.join(', ') || 'None'}</p>
    <p>Access: {manifest.permissions.join(', ') || 'No host permissions requested'}</p>
    <p>Contributions: {contributions.filter(([count]) => count > 0).map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`).join(', ') || 'None'}</p>
    <p className="text-muted-foreground">Only approve code you trust. Extensions run on the machine that runs Cezar, as the user that runs it. Worker isolation is not a security sandbox; permissions limit Cezar APIs, not filesystem or network access.</p>
  </div>
}

function LivePanel({ projectId, extensionId, panelId, onOutcome }: { projectId: string; extensionId: string; panelId: string; onOutcome: (outcome: CommandOutcomeValue) => void }) {
  const queryClient = useQueryClient()
  const panel = useQuery({ queryKey: extensionKeys.panel(projectId, extensionId, panelId), queryFn: () => loadExtensionPanel(projectId, extensionId, panelId) })
  if (panel.isPending) return <LoadingState label="Loading panel…"><RowsSkeleton rows={2} /></LoadingState>
  if (panel.isError) return <div><p role="alert" className="text-sm text-danger">{panel.error.message}</p><Button onClick={() => void panel.refetch()}>Retry panel</Button></div>
  return <ExtensionPanelView panel={panel.data} onAction={async id => {
    onOutcome(await runExtensionCommand(projectId, extensionId, id))
    await queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  }} />
}

function LiveForms({ projectId, extensionId, onOutcome }: { projectId: string; extensionId: string; onOutcome: (outcome: CommandOutcomeValue) => void }) {
  const forms = useQuery({ queryKey: [...extensionKeys.all(projectId), extensionId, 'forms'], queryFn: () => loadExtensionForms(projectId, extensionId) })
  return <>
    {forms.isError && <div><p role="alert" className="text-sm text-danger">{forms.error.message}</p><Button onClick={() => void forms.refetch()}>Retry forms</Button></div>}
    {forms.data?.forms.map(form => <ExtensionFormView key={form.id} form={form} submit={async input => {
      onOutcome(await runExtensionCommand(projectId, extensionId, form.commandId, input))
      const refreshed = await forms.refetch()
      // A failed read may still carry cached data. It is not a canonical save result.
      if (!refreshed.isError) return refreshed.data?.forms.find(saved => saved.id === form.id)
    }} />)}
  </>
}

/** A project's display name; `default` is the boot project's alias. */
function useProjectName(projectId: string): string {
  const projects = useProjects().data
  const id = projectId === 'default' ? projects?.bootProject : projectId
  return projects?.projects.find(project => project.id === id)?.name ?? (projectId === 'default' ? 'the current project' : projectId)
}

/** The registered project the user left to open settings, else the boot project (`default`). */
function useOriginProject(): string {
  const projects = useProjects().data
  const [origin] = useState(() => pathnameProjectId(settingsReturnLocation()?.pathname ?? ''))
  return origin && origin !== projects?.bootProject && projects?.projects.some(project => project.id === origin) ? origin : 'default'
}

/** Global settings: installs are workspace-wide; access is approved per chosen project. */
export function ExtensionsSection() {
  const projects = useProjects().data
  const origin = useOriginProject()
  const [params] = useSearchParams()
  const requested = params.get('project')
  const linkedProject = requested === 'default' || projects?.projects.some(project => project.id === requested) ? requested : undefined
  const [chosen, setChosen] = useState<string>()
  const projectId = chosen ?? (linkedProject === projects?.bootProject ? 'default' : linkedProject) ?? origin
  const boot = projects?.projects.find(project => project.id === projects.bootProject)
  const label = (id: string, name: string) => id === origin ? `${name} (current)` : name
  // The picker stays outside the keyed section so a project change keeps its focus.
  return <div className="flex w-full flex-col gap-5">
    <SettingsCard slot="extensions-project-access" title="Project access" description="Installs are workspace-wide; enabling and running an extension is approved per project.">
      <FormRow label="Project" htmlFor="extensions-project-access">
        <Select value={projectId} onValueChange={setChosen}>
          <SelectTrigger id="extensions-project-access" aria-label="Project access" data-value={projectId} className="w-64 max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="default">{boot ? label('default', boot.name) : 'Current project'}</SelectItem>
            {projects?.projects.filter(project => project.id !== projects.bootProject).map(project => <SelectItem key={project.id} value={project.id}>{label(project.id, project.name)}</SelectItem>)}
          </SelectContent>
        </Select>
      </FormRow>
    </SettingsCard>
    <ProjectExtensions key={projectId} projectId={projectId} />
  </div>
}

const statusPill: Record<NonNullable<ExtensionRecord['status']>, { label: string; tone: StatusDotTone; pulse?: boolean }> = {
  running: { label: 'Running', tone: 'success' },
  starting: { label: 'Starting', tone: 'pending', pulse: true },
  failed: { label: 'Failed', tone: 'danger' },
  disabled: { label: 'Disabled', tone: 'neutral' },
}
function StatusPill({ extension, off = false }: { extension: ExtensionRecord; off?: boolean }) {
  // Installed workers cannot run while off; shipped adapter health is independent.
  if (off) return <Pill dot="neutral"><span className="sr-only">Status: </span>{extension.enabled ? 'Enabled · not running' : 'Disabled'}</Pill>
  const status = statusPill[extension.status ?? (extension.enabled ? 'running' : 'disabled')]
  const label = extension.status ? status.label : extension.enabled ? 'Enabled' : 'Disabled'
  return <Pill dot={status.tone} pulse={status.pulse === true}><span className="sr-only">Status: </span>{label}</Pill>
}
type InstallPreview = Awaited<ReturnType<typeof prepareExtension>>
const projectCount = (count: number) => `${count} project${count === 1 ? '' : 's'}`

/** An installation source is not verified provenance. No path or textual prefix
 * may award first-party trust; that requires host-owned catalog metadata. */
export function extensionSourceLabel(provenance: ExtensionInventoryItem['provenance']): string {
  return { bundled: 'Shipped with Cezar', folder: 'Local extension', npm: 'Public extension' }[provenance.kind]
}
export const extensionAvailabilityLabel: Record<ExtensionInventoryItem['availability'], string> = {
  available: 'Available', disabled: 'Disabled', missing: 'Missing',
  failed: 'Failed', 'flag-disabled': 'Off on this server', hosted: 'Unavailable on this server',
}

function extensionIntegrationHref(projectId: string, providerId: string): string {
  const search = new URLSearchParams({ integration: providerId })
  return `/p/${encodeURIComponent(projectId)}/settings/integrations?${search}`
}
/** What approving this preview does to projects — true for a fresh install and a replacement. */
function installEffect({ replaces }: InstallPreview): string {
  if (!replaces) return 'Installing does not enable it for any project.'
  const head = `Replaces version ${replaces.version}${replaces.sourceChanged ? ' from a different source' : ''}.`
  if (!replaces.enabledProjects) return `${head} It is not enabled in any project.`
  if (replaces.keepsConsent) return `${head} It stays enabled in ${projectCount(replaces.enabledProjects)} and restarts on this version.`
  return `${head} It will be disabled in ${projectCount(replaces.enabledProjects)} until you approve it again${replaces.sourceChanged ? '' : ', because it asks for more access'}.`
}
const offCopy: Record<'flag_off' | 'hosted', string> = {
  flag_off: 'CEZ_EXTENSIONS=0 stops installed extensions. Restart cezar without it to install or run them. Verified shipped integrations can still be managed when permitted by the server.',
  hosted: 'Extensions are off on this hosted cockpit. Set CEZ_REMOTE_EXTENSIONS=1 on the server and restart cezar to install or run them.',
}

const ErrorText = ({ error }: { error: Error | null }) => error ? <p role="alert" className="text-sm text-danger">{error.message}</p> : null

/** One project's access to the global inventory; the section keys it by the chosen project. */
export function ProjectExtensions({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const projectName = useProjectName(projectId)
  const [params] = useSearchParams()
  const selectedExtension = params.get('extension')
  const [source, setSource] = useState('')
  // One result slot for the whole list, shown in the row that produced it.
  const { result, show, dismiss } = useExtensionCommandResult()
  const showResult = (extensionId: string) => (outcome: CommandOutcomeValue) => show(extensionId, outcome)
  const health = useHealth().data
  // An older server sends no flag: treat it as available, the routes still answer 409 if not.
  const off = health?.capabilities?.extensions === false ? health.capabilities.extensionsUnavailableReason ?? 'flag_off' : undefined
  const [browse, setBrowse] = useState(false)
  const [folder, setFolder] = useState<FsBrowseDir | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ source: string; prepared: InstallPreview; target?: { record: ExtensionRecord; candidate: boolean } }>()
  const [enablePreview, setEnablePreview] = useState<ExtensionRecord>()
  // The delete-data choice belongs to one uninstall target: it lives and dies with it.
  const [removal, setRemoval] = useState<{ record: ExtensionRecord; candidate: boolean }>()
  const refresh = () => queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  const extensions = useQuery({ queryKey: extensionKeys.list(projectId), queryFn: () => listExtensions(projectId) })
  const inventory = useQuery({ queryKey: extensionKeys.inventory(projectId), queryFn: ({ signal }) => listExtensionInventory(projectId, signal) })
  const artifactFor = (record: ExtensionRecord, candidate = false) => {
    if (inventory.isError) return undefined
    const item = inventory.data?.extensions.find(item => item.record.manifest.id === record.manifest.id)
    const artifact = candidate ? item?.installedCandidate : item
    return artifact?.record.source === record.source && artifact?.record.integrity === record.integrity && artifact?.selectedVersion === record.manifest.version ? artifact : undefined
  }
  const canEnable = (record: ExtensionRecord) => artifactFor(record)?.management.enable === true
  const softwareAllowed = (record: ExtensionRecord, action: 'update' | 'uninstall', candidate = false) => {
    const artifact = artifactFor(record, candidate)
    return artifact?.provenance.kind !== 'bundled' && artifact?.management[action] === true
  }
  const focusedExtension = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedExtension) { focusedExtension.current = null; return }
    if (focusedExtension.current === selectedExtension) return
    const row = document.getElementById(`extension-${selectedExtension}`)
    if (row) { row.focus(); focusedExtension.current = selectedExtension }
  }, [selectedExtension, inventory.data])
  const prepare = useMutation({ mutationFn: (value: string) => prepareExtension(value), onSuccess: (prepared, value) => setPreview({ source: value, prepared }) })
  const update = useMutation({ mutationFn: ({ record }: { record: ExtensionRecord; candidate: boolean }) => prepareExtensionUpdate(record.manifest.id), onSuccess: (prepared, target) => setPreview({ source: target.record.source, prepared, target }) })
  // A fresh install leaves the extension disabled, so point at the row's Enable as the next step.
  const [installed, setInstalled] = useState<{ id: string; updated: boolean }>()
  const focusedInstall = useRef<typeof installed>(undefined)
  useEffect(() => {
    if (!installed || focusedInstall.current === installed) return
    const row = document.getElementById(`extension-${installed.id}`)
    if (row) { row.focus(); focusedInstall.current = installed }
  }, [installed, inventory.data])
  const install = useMutation({ mutationFn: ({ preparedId }: { preparedId: string; id: string; updated: boolean }) => commitExtension(preparedId), onSuccess: async (_result, { id, updated }) => { setPreview(undefined); setSource(''); setInstalled({ id, updated }); await refresh() } })
  const toggle = useMutation({ mutationFn: ({ id, enabled, integrity }: { id: string; enabled: boolean; integrity?: string }) => enableExtension(projectId, id, enabled, integrity), onSuccess: async () => { setEnablePreview(undefined); await refresh() } })

  const command = useMutation({ mutationFn: ({ id, commandId }: { id: string; commandId: string }) => runExtensionCommand(projectId, id, commandId), onSuccess: async (outcome, { id }) => { showResult(id)(outcome); await refresh() } })
  const mutations = [prepare, update, install, toggle, command]
  const busy = mutations.some(mutation => mutation.isPending)
  /** Clears every earlier failure, so an error on screen always belongs to the latest operation. */
  const fresh = () => { for (const mutation of mutations) mutation.reset(); dismiss(); setInstalled(undefined) }
  const rowError = (id: string) => update.variables?.record.manifest.id === id ? update.error : toggle.variables?.id === id && !enablePreview ? toggle.error : command.variables?.id === id ? command.error : null
  return <div data-slot="extensions-settings-section" className="flex w-full flex-col gap-4">
    {off && <div role="note" data-slot="extensions-off" className="rounded-md border border-border bg-muted/50 p-3 text-ui"><p className="font-medium">Extensions are off on this server</p><p className="text-muted-foreground">{offCopy[off]} Saved installations and approvals are retained. Availability, project access and connection health are shown separately.</p></div>}
    {!off && <SettingsCard slot="extensions-install" title="Install an extension" description={<>Install a package or local folder globally, then approve access for {projectName}. Installation does not enable an extension.</>}>
      <form className="flex flex-col gap-2 px-4 py-3" onSubmit={event => { event.preventDefault(); if (source.trim()) { fresh(); setPreview(undefined); prepare.mutate(source.trim()) } }}>
        <div className="flex gap-2">
          <Input aria-label="Extension folder or package" value={source} onChange={event => setSource(event.target.value)} placeholder="Package name or local folder path" />
          <Button type="submit" disabled={busy || !source.trim()}>Preview install</Button>
        </div>
        <ErrorText error={prepare.error} />
        <div><Button type="button" variant="outline" size="sm" onClick={() => setBrowse(!browse)}>Choose local folder</Button></div>
        {browse && <><FolderBrowser path={path} selected={folder} onSelect={setFolder} onEnter={setPath} emptyHint="Choose a built extension folder." /><div><Button type="button" disabled={!folder} onClick={() => { if (folder) setSource(folder.path); setBrowse(false) }}>Use folder</Button></div></>}
      </form>
    </SettingsCard>}
    {off && <p className="text-ui text-muted-foreground">Install a package or local folder globally, then approve access for {projectName}. Installation does not enable an extension.</p>}
    <Dialog open={!!preview} onOpenChange={open => { if (!open && !busy) { install.reset(); setPreview(undefined) } }}>
      <DialogContent>{preview && <>
        <DialogHeader><DialogTitle>Install {preview.prepared.manifest.name}?</DialogTitle>
          <DialogDescription>Review what this extension can do before installing it. {installEffect(preview.prepared)}</DialogDescription></DialogHeader>
        <PermissionPreview manifest={preview.prepared.manifest} />
        <p className="text-sm [overflow-wrap:anywhere]">Source: {preview.source}</p>
        <p className="text-sm">Added permissions: {preview.prepared.addedPermissions.join(', ') || 'None'}</p>
        <p className="text-sm">Added capabilities: {preview.prepared.addedCapabilities.join(', ') || 'None'}</p>
        <ErrorText error={install.error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { install.reset(); setPreview(undefined) }}>Cancel install</Button>
          <Button disabled={busy || (preview.target ? !softwareAllowed(preview.target.record, 'update', preview.target.candidate) : !!off)} onClick={() => { if (preview.target ? !softwareAllowed(preview.target.record, 'update', preview.target.candidate) : !!off) return; fresh(); install.mutate({ preparedId: preview.prepared.preparedId, id: preview.prepared.manifest.id, updated: !!preview.target }) }}>Approve and install</Button>
        </DialogFooter>
      </>}</DialogContent>
    </Dialog>
    <Dialog open={!!enablePreview} onOpenChange={open => { if (!open && !busy) { toggle.reset(); setEnablePreview(undefined) } }}>
      <DialogContent>{enablePreview && <>
        <DialogHeader><DialogTitle>Enable {enablePreview.manifest.name} for {projectName}?</DialogTitle>
          <DialogDescription>The extension starts and can use the access below in this project.</DialogDescription></DialogHeader>
        <PermissionPreview manifest={enablePreview.manifest} />
        <ErrorText error={toggle.error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { toggle.reset(); setEnablePreview(undefined) }}>Cancel enable</Button>
          <Button disabled={busy || !canEnable(enablePreview)} onClick={() => { if (!canEnable(enablePreview)) return; fresh(); toggle.mutate({ id: enablePreview.manifest.id, enabled: true, integrity: enablePreview.integrity }) }}>Approve and enable</Button>
        </DialogFooter>
      </>}</DialogContent>
    </Dialog>
    {removal && <UninstallDialog key={removal.record.manifest.id} extension={removal.record} candidate={removal.candidate} projectId={projectId} projectName={projectName} blocked={!softwareAllowed(removal.record, 'uninstall', removal.candidate)} onClose={() => setRemoval(undefined)} onRemoved={() => queryClient.invalidateQueries({ queryKey: ['extensions'] })} />}
    {extensions.isError && <div><ErrorText error={extensions.error} /><Button onClick={() => void extensions.refetch()}>Retry extension access</Button></div>}
    {inventory.isPending ? <LoadingState label="Loading extensions…"><RowsSkeleton rows={3} /></LoadingState> : inventory.isError ? <div><ErrorText error={inventory.error} /><Button onClick={() => void inventory.refetch()}>Retry</Button></div> : <ul className="flex flex-col gap-4">
      {inventory.data.extensions.length === 0 && <li className="rounded-md border border-dashed border-border p-4 text-sm"><p className="font-medium">{off ? 'Extension inventory unavailable' : 'No extensions installed'}</p><p className="text-muted-foreground">An extension is an npm package or a built local folder made with the Cezar extension SDK (@open-mercato/cezar-extension-sdk). {off ? 'Install one once extensions are on.' : 'Enter its package name or folder path above to preview what it can do.'}</p></li>}
      {inventory.data.extensions.map(item => {
        const access = !extensions.isError ? extensions.data?.extensions.find(entry => entry.manifest.id === item.record.manifest.id) : undefined
        const extension = item.record
        const canInvoke = !!access && !off && !extensions.isError && access.enabled && (access.status ?? 'running') === 'running'
        const softwareActions = (artifact: ExtensionInventoryItem, candidate = false) => <div className="flex flex-wrap gap-2">
          {softwareAllowed(artifact.record, 'update', candidate) && <Button disabled={busy} variant="outline" onClick={() => { fresh(); setPreview(undefined); update.mutate({ record: artifact.record, candidate }) }}>{artifact.provenance.kind === 'folder' ? 'Reload' : 'Update'}</Button>}
          {softwareAllowed(artifact.record, 'uninstall', candidate) && <Button disabled={busy} variant="danger-ghost" onClick={() => { fresh(); setRemoval({ record: artifact.record, candidate }) }}>Uninstall</Button>}
        </div>
        return <li id={`extension-${extension.manifest.id}`} tabIndex={-1} aria-label={extension.manifest.name} key={extension.manifest.id} className="space-y-3 rounded border border-border p-3">
        {!!item.providers.length && item.installedCandidate && <p className="text-sm font-medium">Selected implementation</p>}
        <div className="flex flex-wrap items-center gap-2"><strong>{extension.manifest.name}</strong><small className="text-muted-foreground">{item.selectedVersion}</small><Pill dot="neutral">{extensionSourceLabel(item.provenance)}</Pill><Pill dot="neutral">{extensionAvailabilityLabel[item.availability]}</Pill>{access && <StatusPill extension={access} off={!!off && item.provenance.kind !== 'bundled'} />}</div>
        <p className="break-all text-sm text-muted-foreground">{extension.source}</p>{(access?.error ?? extension.error) && <p role="alert" className="text-sm text-danger">{access?.error ?? extension.error}</p>}
        {item.availability === 'missing' && item.provenance.kind !== 'bundled' && <p className="text-sm text-muted-foreground">Not installed. This project keeps its approval and the extension’s data for a reinstall. To delete that data and this row, install it again, then Uninstall with “Delete this extension’s data and secrets” selected; the row stays while a chat selection or webhook receiver still uses the extension.</p>}
        {!!item.providers.length && <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Chat connections:</span>{item.providers.map(provider => <Link key={provider.id} className="text-primary underline-offset-4 hover:underline" to={extensionIntegrationHref(projectId, provider.id)}>Manage {provider.label} connection</Link>)}</div>}
        <div className="flex flex-wrap gap-2">
          {item.management.enable && <Button disabled={busy} onClick={() => { fresh(); setEnablePreview(extension) }}>{extension.status === 'failed' ? 'Review and retry' : 'Enable'}</Button>}
          {item.management.disable && <Button disabled={busy} variant="outline" onClick={() => { fresh(); toggle.mutate({ id: extension.manifest.id, enabled: false }) }}>Disable</Button>}
          {softwareActions(item)}
        </div>
        {item.installedCandidate && <section aria-label="Inactive installed candidate" className="space-y-2 rounded border border-border p-3">
          <h3 className="text-sm font-medium">Inactive installed candidate</h3>
          <p className="text-sm">This installed copy is not selected for this project. Review and explicitly select it to change this project’s implementation.</p>
          <div className="flex flex-wrap gap-2"><span>{item.installedCandidate.selectedVersion}</span><Pill dot="neutral">{extensionSourceLabel(item.installedCandidate.provenance)}</Pill><Pill dot="neutral">{extensionAvailabilityLabel[item.installedCandidate.availability]}</Pill></div>
          <p className="break-all text-sm text-muted-foreground">{item.installedCandidate.record.source}</p>
          {softwareActions(item.installedCandidate, true)}
        </section>}
        {/* Any inventory or policy change retires the reviewed selection and its in-flight read. */}
        {/* Retire stale previews; commit ownership lives separately per project/provider in the query client. */}
        {installed?.id === extension.manifest.id && <p role="status" className="text-sm">{installed.updated ? `Updated ${extension.manifest.name}.` : item.management.enable ? `Installed. Enable it for ${projectName} to start it.` : 'Installed.'}</p>}
        <ChatSelection key={JSON.stringify([projectId, item, off, inventory.isError])} item={item} projectId={projectId} projectName={projectName} off={inventory.isError ? 'hosted' : off} refresh={refresh} />
        <ErrorText error={rowError(extension.manifest.id)} />
        {/* Management permission does not imply a worker is available for invocation. */}
        {canInvoke && item.availability === 'available' && extension.enabled && (extension.status ?? 'running') === 'running' && <>
          {!!extension.manifest.contributes?.forms.length && <LiveForms projectId={projectId} extensionId={extension.manifest.id} onOutcome={showResult(extension.manifest.id)} />}
          {(extension.manifest.contributes?.commands ?? []).filter(inSettings).map(action => <Button key={action.id} disabled={busy} variant="outline" onClick={() => { fresh(); command.mutate({ id: extension.manifest.id, commandId: action.id }) }}>{action.label}</Button>)}
          {(extension.manifest.contributes?.panels ?? []).filter(inSettings).map(panel => <LivePanel onOutcome={showResult(extension.manifest.id)} key={panel.id} projectId={projectId} extensionId={extension.manifest.id} panelId={panel.id} />)}
        </>}
        <ExtensionCommandOutcome projectId={projectId} result={result?.extensionId === extension.manifest.id ? result : undefined} onDismiss={dismiss} />
      </li>})}
    </ul>}
  </div>
}

const REFERENCE_LABEL: Record<NonNullable<ExtensionUninstallImpact['projects'][number]['referencedBy']>[number], string> = {
  'chat-selection': 'a chat selection', 'webhook-receiver': 'a webhook receiver',
}

/** A fresh preview belongs to this dialog instance. Closing/switching projects retires its replies. */
function UninstallDialog({ extension, candidate, projectId, projectName, blocked, onClose, onRemoved }: {
  extension: ExtensionRecord; candidate: boolean; projectId: string; projectName: string; blocked: boolean;
  onClose: () => void; onRemoved: () => Promise<unknown>;
}) {
  const [impact, setImpact] = useState<ExtensionUninstallImpact>()
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [removeData, setRemoveData] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [changed, setChanged] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setImpact(undefined); setLoading(true); setError(null)
    void loadUninstallImpact(extension.manifest.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setImpact(value)
    }, reason => { if (!controller.signal.aborted) setError(reason) }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [extension.manifest.id, generation])
  const confirmUninstall = async () => {
    if (!impact || loading || pending || blocked) return
    setPending(true); setError(null)
    try {
      await uninstallExtension(projectId, extension.manifest.id, impact.revision, removeData)
      await onRemoved()
      if (alive.current) onClose()
    } catch (reason) {
      if (!alive.current) return
      if (reason instanceof Error && 'status' in reason && reason.status === 409) {
        setImpact(undefined); setChanged(true); setRemoveData(false); setGeneration(value => value + 1)
      } else setError(reason instanceof Error ? reason : new Error('Uninstall failed'))
    } finally { if (alive.current) setPending(false) }
  }
  return <AlertDialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <AlertDialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
      <div role="region" aria-label="Uninstall impact" tabIndex={0} className="min-h-0 space-y-4 overflow-y-auto [overflow-wrap:anywhere]">
        <AlertDialogHeader><AlertDialogTitle>Uninstall {extension.manifest.name}?</AlertDialogTitle>
          <AlertDialogDescription>This removes the extension from all projects using the installed copy and stops those workers and chat connections, not just those in {projectName}. Configuration and extension data are preserved for reinstallation unless you choose to delete them below.</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm">{candidate ? "This removes the installed copy. The shipped implementation remains selected for this project." : "To stop it only in this project, cancel and use Disable instead."}</p>
        {changed && <p role="alert">The uninstall impact changed. Review the refreshed affected projects and confirm again.</p>}
        {loading && <p role="status">Loading affected projects…</p>}
        {impact && <div className="text-sm"><p className="font-medium">Affected projects (all projects)</p>
          {impact.projects.length ? <ul>{impact.projects.map(project => <li key={project.projectId} className="[overflow-wrap:anywhere]">{project.name} ({project.projectId}) · {project.enabled ? 'Enabled' : 'Disabled'}{project.providers.length > 0 && <> · Providers: {project.providers.join(', ')}</>}{project.referencedBy && <> · Kept as Missing even if data is deleted: {project.referencedBy.map(reference => REFERENCE_LABEL[reference]).join(' and ')} still uses it</>}</li>)}</ul> : <p>No registered projects are affected.</p>}
        </div>}
        <ErrorText error={error} />
        {error && !impact && <Button onClick={() => setGeneration(value => value + 1)}>Retry impact preview</Button>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={removeData} disabled={pending || loading} onChange={event => setRemoveData(event.target.checked)} />Delete this extension’s data and secrets from all registered projects</label>
      </div>
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
        <Button variant="destructive" disabled={blocked || pending || loading || !impact} onClick={() => void confirmUninstall()}>{removeData ? 'Uninstall and delete data' : 'Uninstall and keep data'}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
