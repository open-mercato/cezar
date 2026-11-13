import { createHash } from 'node:crypto'
import {
  extensionChatSelectionCommitSchema, extensionChatSelectionInputSchema, extensionChatSelectionPreviewSchema,
  type ExtensionChatSelectionInput, type ExtensionChatSelectionPreview, type ExtensionRecord,
} from '@open-mercato/cezar-contract'
import { hasChatSelectionOwner, registerDeliveredChatSlot, registerSelectedChatSlot, setChatAdapterEnabled } from '../chat/registry.ts'
import { pinArtifact } from './artifact-leases.ts'
import type { CanonicalChatProvider, ChatSelectionStore, ChatSelectionTarget } from './chat-selection-store.ts'
import { addedCapabilities, addedPermissions, approved, isShippedApproval, shippedRecord } from './consent.ts'
import { isVerifiedChatDelivery, loadChatDeliveryCatalog, type ChatDeliveryArtifact } from './delivery-catalog.ts'
import type { ChatExecutionPolicy, ExtensionManager } from './manager.ts'
import { isUnreadable } from './store.ts'

export type ChatRegistration = Awaited<ReturnType<typeof registerDeliveredChatSlot>>

export async function changeChatConsent(manager: ExtensionManager, provider: ChatDeliveryArtifact['provider'], enabled: boolean): Promise<void> {
  if (hasChatSelectionOwner(manager.projectRoot)) return setChatAdapterEnabled(manager.projectRoot, provider, enabled)
  // Acquire the ordinary state owner without starting any receive/send work. This
  // preserves native consent as well as the project extension approval.
  const owner = await manager.deps.openChatOwner?.()
  try { await setChatAdapterEnabled(manager.projectRoot, provider, enabled) }
  finally { await owner?.dispose() }
}

async function prepareChatSelection(manager: ExtensionManager, provider: CanonicalChatProvider, input: ExtensionChatSelectionInput) {
  const parsed = extensionChatSelectionInputSchema.parse(input)
  const current = await manager.selections.read(provider)
  const { records: approvals, unreadable } = await manager.approvals.snapshot()
  const shipped = async () => {
    const artifact = (await loadChatDeliveryCatalog(manager.deps.deliveryPackageRoot, provider)).find(item => item.provider === provider)
    if (!artifact) throw Error('Shipped chat artifact unavailable')
    return shippedRecord(artifact, true)
  }
  let before: ExtensionRecord | undefined
  if (current?.target.kind === 'installed') before = current.target.record
  else {
    try { before = await shipped() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (before) {
    const approval = approvals.find(item => item.manifest.id === before!.manifest.id)
    const enabled = current?.target.kind === 'installed' ? approved(approval, before) : approval ? isShippedApproval(approval) && approval.enabled : !isUnreadable(unreadable, before.manifest.id)
    before = { ...before, enabled }
  }
  let target: ChatSelectionTarget
  let candidate: ExtensionRecord
  if (parsed.target.kind === 'shipped') {
    target = { kind: 'shipped' }
    candidate = await shipped()
  } else {
    const requested = parsed.target
    const record = (await manager.catalog.list()).find(item => item.manifest.id === requested.extensionId)
    if (!record || record.integrity !== requested.integrity) throw Error('Installed chat candidate changed; review it again')
    target = { kind: 'installed', record, localProviderId: requested.localProviderId }
    await manager.selections.inspect(provider, target)
    candidate = record
  }
  const details = {
    ...parsed, provider, selectionRevision: current?.revision ?? null, current: before ?? null, candidate,
    addedPermissions: addedPermissions(before, candidate), addedCapabilities: addedCapabilities(before, candidate),
  }
  const revision = createHash('sha256').update(JSON.stringify(details)).digest('hex')
  return { preview: extensionChatSelectionPreviewSchema.parse({ ...details, revision }), target, current }
}

/** Read-only consent preview: no workers, approvals, leases or selection writes. */
export async function previewChatSelection(manager: ExtensionManager, provider: CanonicalChatProvider, input: ExtensionChatSelectionInput): Promise<ExtensionChatSelectionPreview> {
  return (await prepareChatSelection(manager, provider, input)).preview
}

export async function selectChat(
  manager: ExtensionManager, provider: CanonicalChatProvider,
  input: ExtensionChatSelectionInput & { revision: string }, policy?: ChatExecutionPolicy,
): Promise<ExtensionChatSelectionPreview> {
  const parsed = extensionChatSelectionCommitSchema.parse(input)
  const assertPolicy = () => {
    const mode = policy?.()
    if (mode === 'blocked' || (mode === 'facade' && parsed.target.kind === 'installed')) throw Error('Chat selection is unavailable under the current cockpit policy')
  }
  const operation = async () => {
    const prepared = await prepareChatSelection(manager, provider, { target: parsed.target, enabled: parsed.enabled })
    if (prepared.preview.revision !== parsed.revision) throw Error('Chat selection preview changed; review it again')
    const prior = [...manager.chatSlots.entries()].find(([, item]) => item.artifact.provider === provider)
    const oldApprovals = await manager.approvals.list()
    const affected = new Set([prepared.preview.current?.manifest.id, prepared.preview.candidate.manifest.id].filter((id): id is string => !!id))
    assertPolicy()
    if (policy) for (const id of affected) manager.setExecutionPolicy(id, policy)
    const wasRunning = [...affected].filter(id => manager.contexts.has(id))
    const oldFailures = new Map([...affected].map(id => [id, manager.failure(id)]))
    let release = async () => {}
    if (prepared.current?.target.kind === 'installed') {
      const record = prepared.current.target.record
      const artifact = await manager.selections.resolve(provider).catch(() => undefined)
      if (artifact) release = await pinArtifact(manager.home, record.manifest.id, createHash('sha256').update(record.integrity!).digest('hex'), artifact.root)
    }
    let committed: Awaited<ReturnType<ChatSelectionStore['replace']>> | undefined
    let nextId: string | undefined
    try {
      // The declaration stays installed while its transport drains, preventing
      // a transient fallback to the private native implementation.
      await changeChatConsent(manager, provider, false)
      for (const id of affected) {
        await manager.stop(id)
        manager.clearFailure(id)
      }
      assertPolicy()
      if (prior) manager.deleteChatSlot(prior[0])
      committed = await manager.selections.replace(provider, prepared.current?.revision ?? null, prepared.target)
      await manager.approvals.update(records => [
        ...records.filter(record => record.manifest.id !== prepared.preview.candidate.manifest.id)
          .map(record => affected.has(record.manifest.id) ? { ...record, enabled: false } : record),
        { ...prepared.preview.candidate, enabled: parsed.enabled },
      ])
      nextId = await declareChatSlot(manager, provider, prior?.[1].registration)
      assertPolicy()
      await changeChatConsent(manager, provider, parsed.enabled)
      assertPolicy()
      if (parsed.enabled) await manager.start((await manager.records()).find(record => record.manifest.id === nextId)!)
      const result = await previewChatSelection(manager, provider, { target: parsed.target, enabled: parsed.enabled })
      assertPolicy()
      return result
    } catch (error) {
      const failedRegistration = nextId ? manager.chatSlots.get(nextId)?.registration : undefined
      if (nextId) {
        await manager.stop(nextId)
        if (!prior && !prepared.preview.current) await failedRegistration?.dispose()
        manager.deleteChatSlot(nextId)
      }
      if (committed) await manager.selections.restore(provider, committed.revision, prepared.current)
      await manager.approvals.update(records => [
        ...records.filter(record => !affected.has(record.manifest.id)),
        ...oldApprovals.filter(record => affected.has(record.manifest.id)),
      ])
      if (prior) manager.setChatSlot(prior[0], prior[1])
      else if (committed && prepared.preview.current) await declareChatSlot(manager, provider, failedRegistration)
      for (const [id, failure] of oldFailures) {
        manager.restoreFailure(id, failure)
      }
      const mayResume = () => {
        try {
          if (prepared.preview.current) manager.executionMode(prepared.preview.current.manifest.id)
          else if (policy?.() === 'blocked') return false
          return true
        } catch { return false }
      }
      await changeChatConsent(manager, provider, mayResume() && (prepared.preview.current?.enabled ?? false))
      const resume = new Set(wasRunning)
      if (!prior && prepared.preview.current?.enabled) resume.add(prepared.preview.current.manifest.id)
      for (const id of resume) {
        const record = (await manager.records()).find(item => item.manifest.id === id && item.enabled)
        if (record && mayResume()) await manager.start(record)
      }
      throw error
    } finally { await release() }
  }
  const current = await manager.selections.read(provider)
  return parsed.target.kind === 'shipped' && current?.target.kind !== 'installed'
    ? manager.serializeChat(operation)
    : manager.serialize(() => manager.serializeChat(operation))
}

export async function declareChatSlot(manager: ExtensionManager, provider: ChatDeliveryArtifact['provider'], registration?: ChatRegistration): Promise<string> {
  await manager.selections.reconcile(provider)
  const selection = await manager.selections.read(provider)
  if (selection?.target.kind === 'installed') {
    const artifact = (await manager.selections.resolve(provider))!
    const existing = manager.chatSlots.get(artifact.extensionId)
    if (existing && (
      isVerifiedChatDelivery(existing.artifact) || existing.artifact.integrity !== artifact.integrity || existing.artifact.provider !== provider
      || (existing.artifact.origin === 'installed' && existing.artifact.localProviderId !== artifact.localProviderId)
    )) throw Error('Chat selection changed during session')
    if (!existing) manager.setChatSlot(artifact.extensionId, {
      artifact, record: selection.target.record,
      registration: registration ?? await registerSelectedChatSlot(manager.projectRoot, artifact, () => manager.startDeliveredChat(provider)),
    })
    return artifact.extensionId
  }

  const artifact = (await loadChatDeliveryCatalog(manager.deps.deliveryPackageRoot, provider)).find(item => item.provider === provider)
  if (!artifact) throw Error('Shipped chat artifact unavailable')
  const id = artifact.manifest.id
  const approval = (await manager.approvals.list()).find(record => record.manifest.id === id)
  const installed = (await manager.catalog.list()).some(record => record.manifest.id === id)
  if (selection?.target.kind !== 'shipped' && installed && !manager.chatSlots.has(id) && !(approval && isShippedApproval(approval))) {
    throw Error('Installed chat selection requires explicit resolution')
  }
  const existing = manager.chatSlots.get(id)
  if (existing && existing.artifact.integrity !== artifact.integrity) throw Error('Shipped artifact changed during session')
  if (!existing) manager.setChatSlot(id, {
    artifact,
    registration: registration ?? await registerDeliveredChatSlot(manager.projectRoot, artifact, () => manager.startDeliveredChat(provider)),
    record: shippedRecord(artifact, true),
  })
  return id
}
