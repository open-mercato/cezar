import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useProjects } from '@/api/queries'
import { extensionChatSelectionParamsSchema, type ExtensionChatSelectionInput, type ExtensionChatSelectionPreview, type ExtensionInventoryItem } from '@open-mercato/cezar-api-client'
import { previewChatSelection, selectChatImplementation } from '@/api/extensions'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Provider = ExtensionChatSelectionPreview['provider']
const canonical = (id: string): id is Provider => extensionChatSelectionParamsSchema.shape.provider.safeParse(id).success

type SelectionProps = {
  item: ExtensionInventoryItem; projectId: string; projectName: string; off?: string; refresh: () => Promise<unknown>
}
type CommitState = { status: 'pending' | 'success' } | { status: 'error'; message: string } | null

/** Writes belong to the project/provider, not to a disposable inventory preview.
 * Keep pending and settled outcomes in the cockpit's query client across unmounts.
 * This key deliberately sits outside inventory invalidation and never fetches/retries. */
function useSelectionCommit(projectId: string, provider: Provider) {
  const client = useQueryClient()
  const key = ['chat-selection-commit', projectId, provider]
  const { data } = useQuery<CommitState>({ queryKey: key, queryFn: () => null, enabled: false, initialData: null, gcTime: Infinity })
  return { state: data, read: () => client.getQueryData<CommitState>(key), write: (value: CommitState) => client.setQueryData(key, value) }
}

/** Canonical identities come from inventory, never package names or paths.
 * The server preview alone authorizes the proposed local provider mapping. */
export function ChatSelection(props: SelectionProps) {
  const projects = useProjects().data
  const projectId = props.projectId === 'default' ? projects?.bootProject : props.projectId
  // An unresolved alias cannot own a write. Mount reviews only once we know the
  // same concrete identity used by explicit project navigation and the request.
  const providers = props.item.providers.filter(provider => canonical(provider.id))
  if (!providers.length) return null
  if (!projectId || projectId === 'default') return <p role="status">Waiting for project identity…</p>
  return <>{providers.map(provider =>
    <ProviderSelection key={JSON.stringify([projectId, provider.id])} {...props} projectId={projectId} provider={provider.id as Provider} label={provider.label} />)}</>
}

function ProviderSelection({ item, projectId, projectName, off, refresh, provider, label }: SelectionProps & { provider: Provider; label: string }) {
  const [request, setRequest] = useState<ExtensionChatSelectionInput>()
  const trigger = useRef<HTMLButtonElement | null>(null)
  const commit = useSelectionCommit(projectId, provider)
  const pending = commit.state?.status === 'pending'
  const candidate = item.installedCandidate
  // Only an unambiguous manifest contribution can be proposed. This is not a trust decision.
  const locals = candidate?.record.manifest.contributes?.chatProviders ?? []
  const local = locals.find(local => local.id === provider) ?? (locals.length === 1 ? locals[0] : undefined)
  const open = (button: HTMLButtonElement, target: ExtensionChatSelectionInput['target']) => {
    if (commit.read()?.status === 'pending') return
    commit.write(null)
    trigger.current = button
    setRequest({ target, enabled: item.record.enabled })
  }
  return <>
    <div className="flex flex-wrap gap-2">
      {candidate?.record.integrity && local && !off && <Button variant="outline" disabled={pending} onClick={event => open(event.currentTarget, { kind: 'installed', extensionId: candidate.record.manifest.id, localProviderId: local.id, integrity: candidate.record.integrity! })}>Use installed version</Button>}
      {item.provenance.kind !== 'bundled' && off !== 'hosted' && <Button variant="outline" disabled={pending} onClick={event => open(event.currentTarget, { kind: 'shipped' })}>Return to version shipped with Cezar</Button>}
    </div>
    {!request && pending && <p role="status">Selecting the {label} implementation for {projectName}…</p>}
    {/* The outcome outlives unmounts for its origin project, so the user dismisses it. */}
    {!request && commit.state?.status === 'error' && <div className="flex items-center gap-2"><p role="alert">{commit.state.message}</p><Button variant="ghost" size="sm" onClick={() => commit.write(null)}>Dismiss</Button></div>}
    {!request && commit.state?.status === 'success' && <div className="flex items-center gap-2"><p role="status">Selected the {label} implementation for {projectName}.</p><Button variant="ghost" size="sm" onClick={() => commit.write(null)}>Dismiss</Button></div>}
    {request && <SelectionDialog provider={provider} label={label} input={request} commit={commit} projectId={projectId} projectName={projectName} onClose={() => setRequest(undefined)} onFocus={() => trigger.current?.focus()} refresh={refresh} />}
  </>
}

function SelectionDialog({ provider, label, input, commit, projectId, projectName, onClose, onFocus, refresh }: {
  commit: ReturnType<typeof useSelectionCommit>; provider: Provider; label: string; input: ExtensionChatSelectionInput; projectId: string; projectName: string;
  onClose: () => void; onFocus: () => void; refresh: () => Promise<unknown>
}) {
  const [preview, setPreview] = useState<ExtensionChatSelectionPreview>()
  const [error, setError] = useState<string>()
  const [generation, setGeneration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setPreview(undefined); setError(undefined)
    void previewChatSelection(projectId, provider, input, controller.signal).then(value => {
      if (controller.signal.aborted) return
      if (input.enabled && !value.current?.enabled) throw new Error('Project access changed. Close this review and refresh the inventory.')
      setPreview(value)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Selection preview failed') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectId, provider, input, generation])
  const confirmSelection = async () => {
    if (!preview || submitting.current || loading || commit.read()?.status === 'pending') return
    submitting.current = true; commit.write({ status: 'pending' }); setPending(true); setError(undefined)
    try {
      await selectChatImplementation(projectId, provider, { target: preview.target, enabled: preview.enabled, revision: preview.revision })
      commit.write({ status: 'success' })
      if (alive.current) onClose()
      // The captured refresh invalidates only the originating project's inventory.
      void refresh().catch(() => {})
    } catch (reason) {
      commit.write({ status: 'error', message: reason instanceof Error ? reason.message : 'Selection failed' })
      if (alive.current) {
        setPreview(undefined)
        setError(reason instanceof Error ? reason.message : 'Selection failed')
      }
    } finally { submitting.current = false; if (alive.current) setPending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose() }}>
    <DialogContent onCloseAutoFocus={event => { event.preventDefault(); onFocus() }} className="max-h-[calc(100dvh-2rem)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
      <div role="region" aria-label="Implementation selection review" tabIndex={0} className="min-h-0 space-y-4 overflow-y-auto [overflow-wrap:anywhere]">
        <DialogHeader><DialogTitle>Select the {label} implementation for {projectName}</DialogTitle><DialogDescription>Review the source and access for this project before confirming.</DialogDescription></DialogHeader>
        <p className="text-sm">Changing code preserves pairings. It does not restore old secrets, state snapshots, checkpoints or completed tasks.</p>
        <p className="text-sm">Project access after selection: {input.enabled ? 'Enabled' : 'Disabled (preserved)'}</p>
        {loading && <p role="status">Loading selection preview…</p>}
        {preview && <>
          <p>Current approval: {preview.current?.enabled ? 'Enabled' : 'Disabled'}</p>
          <p>Current source: {preview.current?.source ?? 'None'} · Version: {preview.current?.manifest.version ?? 'None'}</p>
          <p>Target: {preview.target.kind === 'shipped' ? 'Version shipped with Cezar' : 'Installed version'}</p>
          <p>Target source: {preview.candidate.source} · Version: {preview.candidate.manifest.version}</p>
          <p>Current permissions: {preview.current?.manifest.permissions.join(', ') || 'None'}</p>
          <p>Target permissions: {preview.candidate.manifest.permissions.join(', ') || 'None'}</p>
          <p>Added permissions: {preview.addedPermissions.join(', ') || 'None'}</p>
          <p>Current capabilities: {preview.current?.manifest.capabilities?.join(', ') || 'None'}</p>
          <p>Target capabilities: {preview.candidate.manifest.capabilities?.join(', ') || 'None'}</p>
          <p>Added capabilities: {preview.addedCapabilities.join(', ') || 'None'}</p>
          <p>Only approve code you trust. Extensions run locally as your user; worker isolation is not a security sandbox.</p>
        </>}
        {error && <p role="alert">{error}</p>}
        {!preview && !loading && <Button disabled={pending} onClick={() => setGeneration(value => value + 1)}>Review again</Button>}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel selection</Button>
        <Button disabled={!preview || loading || pending} onClick={() => void confirmSelection()}>Confirm selection</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
