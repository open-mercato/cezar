import { canonicalChatProviderSchema, ChatSelectionStore, type CanonicalChatProvider, type ChatSelection, type SelectedChatArtifact, type UnreadableSelection } from './chat-selection-store.ts'
import { pinArtifact } from './artifact-leases.ts'
import { withLifecycleFileLock } from '../worktree-lifecycle/store.ts'
import { existsSync } from 'node:fs'
import { realpath, mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  type ExtensionChatSelectionInput, type ExtensionChatSelectionPreview,
  DEFAULT_EXTENSION_LOCATION,
  extensionFormSchema,
  extensionPanelSchema,
  validateExtensionForm,
  type ExtensionForm,
  type ExtensionPanel,
  type ExtensionPlacement,
  type ExtensionPlacementLocation,
  type ExtensionRecord,
  type ExtensionInventoryItem,
  type ExtensionUninstallImpact,
  type ExtensionTaskProposal,
} from '@open-mercato/cezar-contract'
import { ChatTransportError } from '../chat/provider.ts'
import { chatDeliveryPackageRoot, loadChatDeliveryCatalog, isVerifiedChatDelivery, type ChatDeliveryArtifact } from './delivery-catalog.ts'
import { cezarHomeDir } from '../paths.ts'
import { SecretStore } from '../workspace/secrets.ts'
import { registerChat } from './chat-registration.ts'
import { changeChatConsent, declareChatSlot, previewChatSelection, selectChat, type ChatRegistration } from './chat-selection.ts'
import { addedCapabilities, addedPermissions, approved, isShippedApproval, keepsConsent } from './consent.ts'
import { ExtensionHostContext, type ExtensionContextDeps } from './context.ts'
import { ExtensionHost } from './host.ts'
import { commitPrepared, enabledProjects, uninstallExtension, uninstallImpact } from './install-transaction.ts'
import { contained } from './install-files.ts'
import { artifactIntegrity, ExtensionInstaller, isPackageSource, sourceIdentity, type PreparedInstall } from './installer.ts'
import { projectInventory, type PinnedSelection } from './inventory.ts'
import { requireExtensionPermission } from './permissions.ts'
import { ExtensionStore, isUnreadable, type UnreadableRecord } from './store.ts'
import { RestartBudget, type RestartBudgetOptions } from './worker-process.ts'

const declaredCommands = (manifest: ExtensionRecord['manifest']) => manifest.contributes?.commands ?? []
const declaredPanels = (manifest: ExtensionRecord['manifest']) => manifest.contributes?.panels ?? []
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

type ManagerDeps = Pick<ExtensionContextDeps, 'listTasks' | 'getTask' | 'proposeTask' | 'events' | 'log'> & {
  secrets?: SecretStore
  deliveryPackageRoot?: string
  workerExecArgv?: readonly string[]
  trustedChatInProcess?: boolean
  executionPolicy?: ChatExecutionPolicy
  chatOnDemand?: boolean
  home?: string
  /** Opens a management-only chat owner when none is live; injected so this layer never imports webhooks. */
  openChatOwner?: () => Promise<{ dispose(): Promise<void> } | undefined>
  /** Restart policy for a worker that dies after activation (defaults: 3 rapid crashes, 1 s backoff doubling). */
  restarts?: RestartBudgetOptions
}
export type ChatExecutionPolicy = () => 'worker' | 'facade' | 'blocked'
type InvokeResult = { ok: boolean; message?: string; proposals?: ExtensionTaskProposal[] }
type ChatSlot = { artifact: ChatDeliveryArtifact | SelectedChatArtifact; record: ExtensionRecord; registration: ChatRegistration }
type Restart = { budget: RestartBudget; startedAt: number; timer?: ReturnType<typeof setTimeout> }
/** The task a `task`-located panel or command is opened for. The id is checked against
 *  THIS project's store before any worker sees it; a caller's project id is never consulted. */
export type TaskCallOptions = { runId?: string }
/** The run a caller named is not in this project — an HTTP 404, never a worker call. */
export class ExtensionRunNotFoundError extends Error {
  constructor() { super('run not found') }
}

/** Installed artifacts are global; approval binds one project to an exact artifact. */
export class ExtensionManager {
  private static readonly listeners = new Set<() => void>()
  private static readonly instances = new Set<ExtensionManager>()
  private static readonly catalogMutations = new Map<string, Promise<unknown>>()

  static subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private static changed() {
    for (const listener of this.listeners) {
      try { listener() } catch { /* optional view */ }
    }
  }

  readonly host: ExtensionHost
  private readonly chatCleanups = new Map<string, (() => Promise<void>)[]>()
  private readonly proposals = new Map<string, { extensionId: string; items: ExtensionTaskProposal[] }>()
  private readonly failures = new Map<string, string>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly restarts = new Map<string, Restart>()
  private readonly previewTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly executionPolicies = new Map<string, ChatExecutionPolicy>()
  /** Read-only views: helpers change state only through the intent-named methods below. */
  get closed(): boolean { return this.isClosed }
  get contexts(): ReadonlyMap<string, ExtensionHostContext> { return this.running }
  get chatSlots(): ReadonlyMap<string, ChatSlot> { return this.slots }
  setChatSlot(id: string, slot: ChatSlot) { this.slots.set(id, slot) }
  deleteChatSlot(id: string) { this.slots.delete(id) }
  setExecutionPolicy(id: string, policy: ChatExecutionPolicy) { this.executionPolicies.set(id, policy) }
  failure(id: string): string | undefined { return this.failures.get(id) }
  /** Puts back a failure recorded before a transaction that is now rolled back. */
  restoreFailure(id: string, failure: string | undefined) {
    if (failure === undefined) this.failures.delete(id)
    else this.failures.set(id, failure)
  }
  /** An explicit choice replaces any pending automatic restart and its crash count. */
  clearFailure(id: string) {
    this.cancelRestart(id)
    this.restarts.delete(id)
    this.failures.delete(id)
  }
  /** Removes a pending install preview and its expiry timer. */
  takePrepared(preparedId: string): { value: PreparedInstall; expiresAt: number } | undefined {
    const preview = this.prepared.get(preparedId)
    this.prepared.delete(preparedId)
    clearTimeout(this.previewTimers.get(preparedId))
    this.previewTimers.delete(preparedId)
    return preview
  }

  executionMode(id: string): 'worker' | 'facade' {
    const mode = this.executionPolicies.get(id)?.() ?? this.deps.executionPolicy?.() ?? (this.deps.trustedChatInProcess ? 'facade' : 'worker')
    const artifact = this.slots.get(id)?.artifact
    if (mode === 'blocked' || (mode === 'facade' && (!artifact || !isVerifiedChatDelivery(artifact)))) throw Error('Chat execution is unavailable under the current cockpit policy')
    return mode
  }
  private readonly slots = new Map<string, ChatSlot>()
  private chatMutations: Promise<unknown> = Promise.resolve()
  private readonly artifacts = new Map<string, string>()
  private readonly pins = new Map<string, () => Promise<void>>()
  private reconcileTimer?: ReturnType<typeof setInterval>
  private reconciledSignature?: string
  private readonly running = new Map<string, ExtensionHostContext>()
  private readonly prepared = new Map<string, { value: PreparedInstall; expiresAt: number }>()
  readonly selections: ChatSelectionStore
  readonly installer: ExtensionInstaller
  readonly catalog: ExtensionStore
  readonly approvals: ExtensionStore
  readonly home: string
  readonly secrets: SecretStore
  private isClosed = false
  private restoreWarned = false
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(
    readonly dataDir: string,
    readonly projectId: string,
    readonly projectRoot: string,
    readonly deps: ManagerDeps = {},
  ) {
    this.host = new ExtensionHost(deps.workerExecArgv)
    this.home = deps.home ?? cezarHomeDir()
    this.secrets = deps.secrets ?? new SecretStore({ ...process.env, CEZ_HOME: this.home })
    this.selections = new ChatSelectionStore(dataDir, this.home)
    this.installer = new ExtensionInstaller(this.home)
    this.catalog = new ExtensionStore(join(this.home, 'extensions', 'registry.json'))
    this.approvals = new ExtensionStore(join(dataDir, 'extensions', 'registry.json'))
    ExtensionManager.instances.add(this)
  }

  serialize<T>(operation: () => Promise<T>, notify = true, empty?: () => T): Promise<T> {
    const previous = ExtensionManager.catalogMutations.get(this.home) ?? Promise.resolve()
    const result = previous.then(async () => {
      if (this.isClosed) throw new Error('extension manager is closed')
      // Empty passive operations still join the queue so reads wait for retirement/pruning.
      if (empty && !this.running.size && !(await this.catalog.list()).length) {
        const { selections, damaged } = await this.readSelections()
        if (!damaged.length && !selections.some(selection => selection?.target.kind === 'installed')) return empty()
      }
      await mkdir(join(this.home, 'extensions'), { recursive: true, mode: 0o700 })
      return withLifecycleFileLock(join(this.home, 'extensions', '.manager.lock'), operation)
    })
    this.mutations = result.catch(() => undefined).finally(() => { if (notify) ExtensionManager.changed() })
    ExtensionManager.catalogMutations.set(this.home, this.mutations)
    return result
  }

  /** Shipped selections are project-owned and never require a writable global home. */
  serializeChat<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chatMutations.then(async () => {
      if (this.isClosed) throw new Error('extension manager is closed')
      await mkdir(join(this.dataDir, 'extensions'), { recursive: true, mode: 0o700 })
      return withLifecycleFileLock(join(this.dataDir, 'extensions', '.delivery.lock'), operation)
    })
    this.chatMutations = result.catch(() => undefined).finally(() => ExtensionManager.changed())
    return result
  }
  peers() {
    return [...ExtensionManager.instances].filter(manager => manager.home === this.home && !manager.isClosed)
  }

  private readonly reported = new Set<string>()
  private report(key: string, message: string, id = 'extensions') {
    if (this.reported.has(key)) return
    this.reported.add(key)
    if (this.deps.log) this.deps.log('error', message, id)
    else console.warn(message)
  }

  private reportRows(store: ExtensionStore, rows: UnreadableRecord[]) {
    for (const row of rows) this.report(`${store.file}:${row.id ?? ''}`, `Stored extension record is unreadable in ${store.file}${row.id ? ` (${row.id})` : ''}`, row.id)
  }

  /** Every provider's selection; a damaged one is reported and answers only for itself. */
  private async readSelections(): Promise<{ selections: (ChatSelection | undefined)[]; damaged: UnreadableSelection[] }> {
    const reads = await Promise.all(canonicalChatProviderSchema.options.map(provider => this.selections.peek(provider)))
    const damaged = reads.flatMap(read => read.unreadable ? [read.unreadable] : [])
    for (const item of damaged) this.report(`selection:${item.provider}`, item.message, item.extensionId)
    return { selections: reads.map(read => read.selection), damaged }
  }

  private status(id: string): NonNullable<ExtensionRecord['status']> {
    if (this.restarts.get(id)?.timer) return 'starting'
    if (this.failures.has(id)) return 'failed'
    if (this.starting.has(id)) return 'starting'
    if (this.running.has(id)) return 'running'
    return 'disabled'
  }

  async list(): Promise<ExtensionRecord[]> {
    if (this.isClosed) return this.records()
    if (this.slots.size && !(await this.catalog.list()).length) { await this.chatMutations; return this.records() }
    try {
      return await this.serialize(async () => { await this.reconcile(); return this.records() }, false, () => [])
    } catch (error) {
      if (!this.isClosed && !this.storageUnavailable(error)) throw error
      await this.stopForUnavailableStorage()
      return this.records()
    }
  }

  private storageUnavailable(error: unknown): boolean {
    return ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
  }

  private async stopForUnavailableStorage() {
    // No unlocked reconciliation: leases and artifact identity remain mandatory.
    for (const id of this.restarts.keys()) this.cancelRestart(id)
    await Promise.all([...this.running.keys()].map(id => this.stop(id)))
  }

  /** What a reconcile reads. Writes are atomic renames, so a changed inode marks any file change. */
  private async catalogSignature(): Promise<string> {
    const files = [this.catalog.file, this.approvals.file, ...canonicalChatProviderSchema.options.map(provider => this.selections.file(provider))]
    const stats = await Promise.all(files.map(file => stat(file).then(info => `${info.ino}:${info.mtimeMs}:${info.size}`, () => '')))
    return JSON.stringify([stats, [...this.running.keys()], [...this.failures.keys()], [...this.slots.keys()]])
  }

  /** An idle poll is a few stats: only a change pays for the mkdir, the lock and the registry reads. */
  private async reconcileIfChanged() {
    const signature = await this.catalogSignature()
    if (signature === this.reconciledSignature) return
    await this.serialize(() => this.reconcile(), false)
    this.reconciledSignature = signature
  }

  /** Reconcile quiet receivers too: no UI read is required to retire a revoked worker.
   * Calls and list projections also reconcile under the cross-process mutation lock. */
  private watchCatalog() {
    if (this.reconcileTimer || this.isClosed) return
    let checking = false
    this.reconcileTimer = setInterval(() => {
      if (checking || this.isClosed) return
      checking = true
      void this.reconcileIfChanged().catch(() => undefined).finally(() => { checking = false })
    }, 500)
    this.reconcileTimer.unref()
  }

  private artifactKey(record: ExtensionRecord) { return JSON.stringify([record.integrity, record.manifest.version, record.installedAt]) }

  private async reconcile() {
    const records = await this.records()
    const retired = new Set<string>()
    let changed = false
    for (const id of this.running.keys()) {
      const record = records.find(item => item.manifest.id === id)
      if (!record?.enabled || this.artifacts.get(id) !== this.artifactKey(record)) {
        await this.stop(id)
        retired.add(id)
      }
    }
    for (const record of records) {
      const id = record.manifest.id
      if (!record.enabled || (this.deps.chatOnDemand && this.slots.has(id)) || this.running.has(id) || this.failures.has(id) || this.restarts.get(id)?.timer) continue
      await this.start(record).catch(() => undefined)
      changed = true
    }
    if (retired.size || changed) ExtensionManager.changed()
    for (const id of retired) {
      await this.installer.pruneArtifacts(id, records.find(record => record.manifest.id === id)?.integrity).catch(() => undefined)
    }
  }

  async records(): Promise<ExtensionRecord[]> {
    const [{ records: installed, unreadable: lostInstalls }, { records: approvals, unreadable: lostApprovals }, { selections, damaged }] = await Promise.all([this.catalog.snapshot(), this.approvals.snapshot(), this.readSelections()])
    this.reportRows(this.catalog, lostInstalls)
    this.reportRows(this.approvals, lostApprovals)
    const selectedRecords = await Promise.all([...this.slots.values()].map(async item => {
      const id = item.record.manifest.id
      const approval = approvals.find(record => record.manifest.id === id)
      let enabled: boolean
      if (isVerifiedChatDelivery(item.artifact)) {
        const shippedConsent = approval ? isShippedApproval(approval) && approval.enabled : item.record.enabled && !isUnreadable(lostApprovals, id)
        enabled = shippedConsent && !damaged.some(entry => entry.provider === item.artifact.provider)
      }
      else {
        const current = await this.selections.read(item.artifact.provider)
        enabled = current?.target.kind === 'installed' && current.target.record.manifest.id === id
          && current.target.record.integrity === item.artifact.integrity
          && current.target.localProviderId === (item.artifact.origin === 'installed' ? item.artifact.localProviderId : undefined)
          && approved(approval, item.record)
      }
      return { ...item.record, enabled, status: this.status(id) }
    }))
    // A missing selected artifact still owns its identity. Never project or start
    // a different global candidate in that slot merely because declaration failed.
    const unavailable = selections.flatMap(selection => selection?.target.kind === 'installed' && !this.slots.has(selection.target.record.manifest.id) ? [selection.target.record] : [])
    const pinnedIds = new Set(unavailable.map(record => record.manifest.id))
    const pending = unavailable.map(record => {
      const id = record.manifest.id
      const failure = this.failures.get(id)
      return { ...record, enabled: approved(approvals.find(item => item.manifest.id === id), record), status: this.status(id), ...(failure !== undefined ? { error: failure } : {}) }
    })
    const standalone = installed.filter(record => !this.slots.has(record.manifest.id) && !pinnedIds.has(record.manifest.id)).map(record => {
      const id = record.manifest.id
      const status = this.status(id)
      const error = status === 'failed' ? this.failures.get(id) : undefined
      const approval = approvals.find(item => item.manifest.id === id)
      const lost = damaged.find(entry => entry.extensionId === id)
      return { ...record, status, ...(lost ? { error: lost.message.slice(0, 500) } : error ? { error } : {}), enabled: !lost && !!record.integrity && approved(approval, record) }
    })
    return selectedRecords.concat(pending, standalone)
  }

  async installed(): Promise<ExtensionRecord[]> { return this.catalog.list() }

  /** Metadata reads never reconcile, create leases or activate extension code. */
  async inventory(unavailable?: 'flag-disabled' | 'hosted'): Promise<ExtensionInventoryItem[]> {
    const [{ records: installed, unreadable: lostInstalls }, { records: saved, unreadable: lostApprovals }, shipped, { selections, damaged }] = await Promise.all([
      this.catalog.snapshot(), this.approvals.snapshot(),
      loadChatDeliveryCatalog(this.deps.deliveryPackageRoot).catch(() => []),
      this.readSelections(),
    ])
    this.reportRows(this.catalog, lostInstalls)
    this.reportRows(this.approvals, lostApprovals)
    const pinned = new Map<string, PinnedSelection>()
    for (const [index, provider] of canonicalChatProviderSchema.options.entries()) {
      const selection = selections[index]
      if (selection?.target.kind !== 'installed') continue
      const present = !!await this.selections.resolve(provider).catch(() => undefined)
      pinned.set(selection.target.record.manifest.id, { provider, target: selection.target, present })
    }
    let hostVersion = 'unknown'
    if (shipped.length) {
      try {
        const pkg = JSON.parse(await readFile(join(this.deps.deliveryPackageRoot ?? chatDeliveryPackageRoot(), 'package.json'), 'utf8')) as { version?: unknown }
        if (typeof pkg.version === 'string') hostVersion = pkg.version
      } catch { /* Missing release metadata must not start code or fail discovery. */ }
    }
    return projectInventory({ installed, saved, shipped, pinned, hostVersion, unavailable, status: id => this.status(id), failed: id => this.failures.has(id), lost: { installs: lostInstalls, approvals: lostApprovals, selections: damaged } })
  }

  uninstallImpact(extensionId: string): Promise<ExtensionUninstallImpact> { return uninstallImpact(this, extensionId) }


  async prepareUpdate(id: string) {
    if (!(await this.catalog.list()).some(record => record.manifest.id === id) && await this.canManageDelivered(id)) throw Error('Shipped adapters are updated with the host')
    const record = (await this.catalog.list()).find(item => item.manifest.id === id)
    if (!record) throw new Error('extension not found')
    const preview = await this.prepare(record.source)
    if (preview.manifest.id !== id) {
      await this.discard(preview.preparedId)
      throw new Error('extension id changed during update')
    }
    return preview
  }

  async install(source: string): Promise<ExtensionRecord> {
    return this.commit((await this.prepare(source)).preparedId)
  }

  async prepare(source: string) {
    if (this.isClosed) throw new Error('extension manager is closed')
    for (const [id, preview] of this.prepared) {
      if (preview.expiresAt >= Date.now()) continue
      this.prepared.delete(id)
      await this.installer.discardInstall(preview.value)
    }
    if (this.prepared.size >= 10) throw new Error('too many pending extension previews')
    const local = resolve(this.projectRoot, source)
    const value = await this.installer.prepareInstall(!isPackageSource(source) && existsSync(local) ? local : source)
    if (this.isClosed) {
      await this.installer.discardInstall(value)
      throw new Error('extension manager is closed')
    }
    const previous = (await this.catalog.list()).find(record => record.manifest.id === value.id)
    const next = { manifest: value.manifest, source: value.source }
    const replaces = previous ? {
      version: previous.manifest.version,
      sourceChanged: sourceIdentity(previous.source) !== sourceIdentity(value.source),
      keepsConsent: keepsConsent({ ...previous, enabled: true }, next),
      enabledProjects: await enabledProjects(this, previous),
    } : undefined
    const preparedId = randomUUID()
    this.prepared.set(preparedId, { value, expiresAt: Date.now() + 10 * 60_000 })
    const timer = setTimeout(() => { void this.discard(preparedId).catch(() => undefined) }, 10 * 60_000)
    timer.unref()
    this.previewTimers.set(preparedId, timer)
    return {
      preparedId,
      manifest: value.manifest,
      addedPermissions: addedPermissions(previous, next),
      addedCapabilities: addedCapabilities(previous, next),
      ...(replaces ? { replaces } : {}),
    }
  }

  commit(preparedId: string): Promise<ExtensionRecord> { return commitPrepared(this, preparedId) }

  approve(record: ExtensionRecord) {
    return this.approvals.update(records => [...records.filter(item => item.manifest.id !== record.manifest.id), record])
  }

  uninstall(id: string, removeData = false, impactRevision?: string): Promise<boolean> { return uninstallExtension(this, id, removeData, impactRevision) }

  /** Read-only authorization for the flag-off shipped-code exception. */
  async canManageDelivered(id: string): Promise<boolean> {
    const { selections, damaged } = await this.readSelections()
    if (damaged.some(item => item.extensionId === id) || selections.some(selected => selected?.target.kind === 'installed' && selected.target.record.manifest.id === id)) return false
    const prior = (await this.approvals.list()).find(record => record.manifest.id === id)
    if (prior && !isShippedApproval(prior)) return false
    if ((await this.catalog.list()).some(record => record.manifest.id === id) && !(prior && isShippedApproval(prior))) return false
    return (await loadChatDeliveryCatalog(this.deps.deliveryPackageRoot).catch(() => [])).some(item => item.extensionId === id)
  }

  async setEnabled(id: string, enabled: boolean, integrity?: string, policy: { shippedOnly?: boolean } = {}): Promise<ExtensionRecord | undefined> {
    // Global catalog first, project selection second: installation uses the same order.
    // Cached declarations are not authority over a newer durable selection.
    const operation = async () => {
      const { selections, damaged } = await this.readSelections()
      for (const [index, provider] of canonicalChatProviderSchema.options.entries()) {
        const selection = selections[index]
        if (selection?.target.kind === 'installed' && selection.target.record.manifest.id === id) await declareChatSlot(this, provider)
      }
      const installed = (await this.catalog.list()).find(record => record.manifest.id === id)
      const selected = (await this.approvals.list()).find(record => record.manifest.id === id)
      const artifact = (await loadChatDeliveryCatalog(this.deps.deliveryPackageRoot).catch(() => [])).find(item => item.extensionId === id)
      const lost = damaged.find(item => item.extensionId === id || item.provider === artifact?.provider)
      if (enabled && lost) throw new Error(lost.message)
      const pinned = this.slots.get(id)?.artifact
      const external = pinned && !isVerifiedChatDelivery(pinned)
      const foreign = selected && !isShippedApproval(selected)
      if (policy.shippedOnly && (external || (installed && !(selected && isShippedApproval(selected))) || foreign || !artifact)) {
        throw Error('Shipped chat selection changed; review the current selection')
      }
      if (this.slots.has(id) && !external && (foreign || !artifact)) throw Error('Chat selection changed; cached shipped declaration is no longer authoritative')
      if (artifact && !external && this.slots.has(id) && this.slots.get(id)!.artifact.integrity !== artifact.integrity) throw Error('Shipped artifact changed during session')
      if (!this.slots.has(id) && (!installed || (selected && isShippedApproval(selected))) && artifact && !foreign) await declareChatSlot(this, artifact.provider)
      const record = (await this.records()).find(item => item.manifest.id === id)
      if (!record) return undefined
      if (enabled && integrity !== undefined && integrity !== record.integrity) {
        throw new Error('extension artifact changed; review its permissions again')
      }
      this.clearFailure(id)
      const next = { ...record, enabled }
      try {
        // Retire receive guards before making revocation visible to host service
        // authorization. Otherwise an in-flight session treats intentional disable
        // as a fatal protocol failure and persists fatalStop across re-enable.
        const slot = this.slots.get(id)
        if (slot && record.enabled !== enabled) await changeChatConsent(this, slot.artifact.provider, enabled)
        if (!enabled) await this.stop(id)
        await this.approve(next)
        if (enabled) await this.start(next)
      } catch (error) {
        await this.approve(record)
        const slot = this.slots.get(id)
        if (slot && record.enabled !== enabled) await changeChatConsent(this, slot.artifact.provider, record.enabled)
        if (!enabled && record.enabled) await this.start(record)
        throw error
      }
      return next
    }
    return this.serialize(() => this.serializeChat(operation))
  }

  private cancelRestart(id: string) {
    const restart = this.restarts.get(id)
    if (!restart?.timer) return
    clearTimeout(restart.timer)
    restart.timer = undefined
  }

  stop(id: string): Promise<void> {
    this.cancelRestart(id)
    const existing = this.stopping.get(id)
    if (existing) return existing
    for (const [key, queue] of this.proposals) {
      if (queue.extensionId === id) this.proposals.delete(key)
    }
    this.running.get(id)?.disable()
    this.running.delete(id)
    this.artifacts.delete(id)
    const cleanups = this.chatCleanups.get(id) ?? []
    this.chatCleanups.delete(id)
    const stopping = (async () => {
      await this.host.deactivate(id)
      for (const cleanup of cleanups) await cleanup()
      const release = this.pins.get(id)
      this.pins.delete(id)
      await release?.()
    })()
    this.stopping.set(id, stopping)
    void stopping.finally(() => { if (this.stopping.get(id) === stopping) this.stopping.delete(id) }).catch(() => undefined)
    return stopping
  }

  async start(record: ExtensionRecord): Promise<void> {
    const id = record.manifest.id
    const existing = this.starting.get(id)
    if (existing) return existing
    const failure = this.failures.get(id)
    if (failure) throw new Error(failure)
    const starting = this.activate(record)
    this.starting.set(id, starting)
    try {
      await starting
    } catch (error) {
      this.failures.set(id, error instanceof Error ? error.message.slice(0, 500) : 'Extension failed')
      throw error
    } finally {
      if (this.starting.get(id) === starting) this.starting.delete(id)
    }
  }

  /** A worker died after activation: restart it with bounded backoff, then leave it visibly failed. */
  private crashed(record: ExtensionRecord, message: string) {
    const id = record.manifest.id
    this.failures.set(id, message)
    const restart = this.restarts.get(id)
    void this.stop(id).catch(() => undefined).finally(() => {
      // An explicit enable/disable/update during teardown replaced this restart record.
      if (!restart || this.isClosed || this.restarts.get(id) !== restart) return ExtensionManager.changed()
      const next = restart.budget.crashed(restart.startedAt)
      if (!next) {
        this.deps.log?.('error', `worker failed repeatedly; restarts exhausted (${message})`, id)
        return ExtensionManager.changed()
      }
      this.deps.log?.('error', `worker exited (${message}); restarting (attempt ${next.attempt})`, id)
      restart.timer = setTimeout(() => {
        restart.timer = undefined
        if (this.isClosed || this.restarts.get(id) !== restart) return
        this.failures.delete(id)
        // A failed re-activation is final and visible; only a crash after activation retries.
        const restartOperation = async () => {
          const current = (await this.records()).find(item => item.manifest.id === id && item.enabled)
          if (current) await this.start(current)
          else await this.stop(id)
        }
        void (this.slots.has(id) ? this.serializeChat(restartOperation) : this.serialize(restartOperation)).catch(() => undefined)
      }, next.delayMs)
      restart.timer.unref()
      ExtensionManager.changed()
    })
  }
  previewChatSelection(provider: CanonicalChatProvider, input: ExtensionChatSelectionInput): Promise<ExtensionChatSelectionPreview> {
    return previewChatSelection(this, provider, input)
  }

  selectChat(provider: CanonicalChatProvider, input: ExtensionChatSelectionInput & { revision: string }, policy?: ChatExecutionPolicy): Promise<ExtensionChatSelectionPreview> {
    return selectChat(this, provider, input, policy)
  }

  /** Verify and declare the canonical identity without starting executable code. */
  async declareDeliveredChat(provider: ChatDeliveryArtifact['provider']): Promise<void> {
    await this.serializeChat(async () => { await declareChatSlot(this, provider) })
  }

  /** Explicit lifecycle entry used by configured native chat, never by metadata reads. */
  async startDeliveredChat(provider: ChatDeliveryArtifact['provider']): Promise<void> {
    return this.serializeChat(async () => {
      const id = await declareChatSlot(this, provider)
      const record = (await this.records()).find(item => item.manifest.id === id)!
      if (record.enabled) await this.start(record)
    })
  }

  private async activate(record: ExtensionRecord): Promise<void> {
    const id = record.manifest.id
    await this.stopping.get(id)
    if (this.isClosed) throw new Error('extension manager is closed')
    if (this.running.has(id)) return
    if (!record.integrity) throw new Error('reinstall this extension to create an immutable artifact')
    const digest = createHash('sha256').update(record.integrity).digest('hex')
    if (!this.slots.has(id)) {
      const { selections } = await this.readSelections()
      for (const [index, provider] of canonicalChatProviderSchema.options.entries()) {
        const selection = selections[index]
        if (selection?.target.kind === 'installed' && selection.target.record.manifest.id === id) await this.serializeChat(() => declareChatSlot(this, provider))
      }
    }
    const slot = this.slots.get(id)?.artifact
    const root = await realpath(slot?.root ?? join(this.home, 'extensions', 'artifacts', id, record.manifest.version, digest))
    if (await artifactIntegrity(root) !== record.integrity) throw new Error('installed extension artifact changed; reinstall and review it')
    const entry = await realpath(resolve(root, record.manifest.entry))
    if (!contained(root, entry)) throw new Error('extension entry must stay inside its installed directory')
    if (this.isClosed) throw new Error('extension manager is closed')

    // Distribution artifacts are immutable and not owned/pruned by ExtensionInstaller.
    // They require no writable home or synthetic install/approval record.
    if (slot && !isVerifiedChatDelivery(slot) && this.deps.trustedChatInProcess && !this.executionPolicies.has(id) && !this.deps.executionPolicy) {
      throw Error('Installed chat selection unavailable while extensions are disabled')
    }
    this.executionMode(id)
    const release = slot && isVerifiedChatDelivery(slot) ? async () => {} : await pinArtifact(this.home, id, digest, root)
    this.pins.set(id, release)
    this.artifacts.set(id, this.artifactKey(record))
    if (!slot || !isVerifiedChatDelivery(slot)) this.watchCatalog()
    const context = this.createContext(record)
    this.running.set(id, context)
    let restart = this.restarts.get(id)
    if (!restart) {
      restart = { budget: new RestartBudget(this.deps.restarts), startedAt: 0 }
      this.restarts.set(id, restart)
    }
    restart.startedAt = Date.now()
    try {
      const mode = this.executionMode(id)
      await this.host.activate({
        ...(slot && isVerifiedChatDelivery(slot) && mode === 'facade' ? { trustedInProcess: slot } : {}),
        id,
        manifest: record.manifest,
        entry,
        projectId: this.projectId,
        sanitize: value => context.redact(value),
        onFailure: error => {
          context.disable()
          this.running.delete(id)
          this.artifacts.delete(id)
          this.pins.delete(id)
          void release()
          this.crashed(record, context.redact(error.message).slice(0, 500))
        },
        dispatch: (method, params, signal, invocationId) => {
          this.executionMode(id)
          return context.dispatch(method, params, signal, invocationId)
        },
        ...(record.manifest.permissions.includes('project.read')
          ? { subscribe: (listener: (event: unknown) => void) => context.subscribe(listener) }
          : {}),
      })
      if (this.executionMode(id) !== mode) throw Error('Chat execution policy changed during activation')
    } catch (error) {
      await this.host.deactivate(id)
      context.disable()
      this.running.delete(id)
      this.artifacts.delete(id)
      this.pins.delete(id)
      await release()
      const message = context.redact(errorMessage(error, 'Extension activation failed'))
      this.failures.set(id, message.slice(0, 500))
      throw new Error(message)
    }
    const cleanups: (() => Promise<void>)[] = []
    this.chatCleanups.set(id, cleanups)
    try {
      for (const declaration of record.manifest.contributes?.chatProviders ?? []) {
        this.executionMode(id)
        cleanups.push(await registerChat(this, record, declaration, context))
        this.executionMode(id)
      }
    } catch (error) {
      await this.stop(id)
      throw error
    }
  }

  private createContext(record: ExtensionRecord): ExtensionHostContext {
    const id = record.manifest.id
    return new ExtensionHostContext({
      ...this.deps,
      secrets: this.secrets,
      dataDir: this.dataDir,
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      extensionId: id,
      permissions: record.manifest.permissions,
      proposeTask: async (proposal, invocationId) => {
        if (this.isClosed || !this.running.has(id)) throw new Error('extension stopped')
        const queue = invocationId ? this.proposals.get(invocationId) : undefined
        if (!queue || queue.extensionId !== id) throw new Error('Task proposals require an active command invocation')
        if (queue.items.length >= 10) throw new Error('too many pending task proposals')
        queue.items.push(proposal)
        return { proposalId: randomUUID(), accepted: false }
      },
    })
  }

  async assertCurrent(record: ExtensionRecord) {
    const current = (await this.records()).find(item => item.manifest.id === record.manifest.id)
    try { this.executionMode(record.manifest.id) } catch (error) {
      void this.stop(record.manifest.id).catch(() => undefined)
      throw error
    }
    if (this.isClosed || !current?.enabled || this.artifactKey(current) !== this.artifactKey(record)) {
      // Revocation may come from another process between reconciler ticks.
      // Invalidate this generation synchronously, then drain outside the host
      // service call (awaiting its own teardown here would deadlock).
      if (this.artifacts.get(record.manifest.id) === this.artifactKey(record)) {
        void this.stop(record.manifest.id).catch(() => undefined)
      }
      throw new ChatTransportError({ kind: 'blocked' })
    }
  }

  async restore(options: { chatOnDemand?: boolean } = {}): Promise<void> {
    if (this.isClosed) return
    try {
      await this.serialize(async () => {
        const { selections } = await this.readSelections()
        for (const [index, provider] of canonicalChatProviderSchema.options.entries()) {
          const selection = selections[index]
          if (selection?.target.kind !== 'installed') continue
          try { await this.serializeChat(() => declareChatSlot(this, provider)) } catch {
            const id = selection.target.record.manifest.id
            this.failures.set(id, 'Selected chat artifact unavailable')
            await this.stop(id)
          }
        }
        const records = await this.records()
        if (records.length) this.watchCatalog()
        for (const record of records) {
          if (!record.enabled || ((options.chatOnDemand || this.deps.chatOnDemand) && this.slots.has(record.manifest.id))) continue
          // A failed activation stays visible; only a crash after activation restarts on its own.
          try { await this.start(record) } catch { /* recorded in failures */ }
        }
      }, true, () => undefined)
    } catch {
      await this.stopForUnavailableStorage()
      if (!this.isClosed && !this.restoreWarned) {
        this.restoreWarned = true
        const message = 'Extensions unavailable: could not restore from local storage'
        if (this.deps.log) this.deps.log('error', message, 'extensions')
        else console.warn(message)
      }
    }
  }

  async discard(preparedId: string): Promise<void> {
    const preview = this.takePrepared(preparedId)
    if (preview) await this.installer.discardInstall(preview.value)
  }

  private async enabled(id: string): Promise<ExtensionRecord> {
    const record = (await this.list()).find(item => item.manifest.id === id && item.enabled)
    if (!record) {
      await this.stop(id)
      throw new Error('extension is not enabled')
    }
    if (!this.running.has(id)) throw new Error(this.failures.get(id) ?? 'extension is not running; enable or retry it')
    return record
  }

  /** Enabled extensions' contributions for one surface, with the `settings` default applied.
   *  An extension with nothing at `location` is left out. Running or not: a failed worker is
   *  listed with its status so the surface can say so instead of going blank. */
  async placements(location: ExtensionPlacementLocation): Promise<ExtensionPlacement[]> {
    const placements: ExtensionPlacement[] = []
    for (const record of await this.list()) {
      if (!record.enabled) continue
      const panels = declaredPanels(record.manifest)
        .map(panel => ({ id: panel.id, title: panel.title, location: panel.location ?? DEFAULT_EXTENSION_LOCATION }))
        .filter(panel => panel.location === location)
      const commands = declaredCommands(record.manifest)
        .map(command => ({ id: command.id, title: command.label, location: command.location ?? DEFAULT_EXTENSION_LOCATION }))
        .filter(command => command.location === location)
      if (!panels.length && !commands.length) continue
      placements.push({
        extensionId: record.manifest.id, name: record.manifest.name, status: this.status(record.manifest.id),
        ...(record.error ? { error: record.error } : {}), panels, commands,
      })
    }
    return placements
  }

  /** A named run must exist in THIS project's store, whatever the contribution's location; it is
   *  handed to the worker only for a `task`-located one (sidebar/palette get no task). */
  private async taskContext(location: string | undefined, runId: string | undefined): Promise<string | undefined> {
    if (runId === undefined) return undefined
    if (!await this.deps.getTask?.(runId)) throw new ExtensionRunNotFoundError()
    return (location ?? DEFAULT_EXTENSION_LOCATION) === 'task' ? runId : undefined
  }

  async panel(id: string, panelId: string, options: TaskCallOptions = {}): Promise<ExtensionPanel | undefined> {
    const record = await this.enabled(id)
    const declaration = declaredPanels(record.manifest).find(panel => panel.id === panelId)
    if (!declaration) return undefined
    const runId = await this.taskContext(declaration.location, options.runId)
    const raw = await this.host.panel(id, panelId, runId).catch((error: unknown) => {
      // The IPC frame cap is the worker's wording; the card promises this one (spec 2026-11-07-extension-placements).
      if (error instanceof Error && /exceeds 1 MiB/.test(error.message)) throw new Error('Panel too large')
      throw error
    })
    const panel = extensionPanelSchema.parse(this.running.get(id)!.redact(raw))
    if (panel.id !== panelId) throw new Error('extension panel identity changed')
    const commands = declaredCommands(record.manifest)
    if (panel.actions.some(action => !commands.some(command => command.id === action.id))) {
      throw new Error('extension panel references an undeclared command')
    }
    return panel
  }

  async forms(id: string): Promise<ExtensionForm[]> {
    const record = await this.enabled(id)
    const commands = declaredCommands(record.manifest)
    const result: ExtensionForm[] = []
    for (const declaration of record.manifest.contributes?.forms ?? []) {
      const form = extensionFormSchema.parse(this.running.get(id)!.redact(await this.host.form(id, declaration.id)))
      if (form.id !== declaration.id || !commands.some(command => command.id === form.commandId)) {
        throw new Error('undeclared form command')
      }
      if (form.commandId !== declaration.commandId || JSON.stringify(form.fields) !== JSON.stringify(declaration.fields)) {
        throw new Error('extension form fields changed from the approved declaration')
      }
      if (form.values) {
        for (const field of form.fields) if (field.type === 'password') delete form.values[field.key]
      }
      result.push(form)
    }
    return result
  }

  async invoke(id: string, actionId: string, input?: Record<string, unknown>, options: TaskCallOptions = {}): Promise<InvokeResult> {
    const record = await this.enabled(id)
    const action = declaredCommands(record.manifest).find(item => item.id === actionId)
    if (!action) throw new Error('extension action is not declared')
    if (action.permission) requireExtensionPermission(record.manifest.permissions, action.permission)
    const runId = await this.taskContext(action.location, options.runId)
    const forms = (record.manifest.contributes?.forms ?? []).filter(form => form.commandId === actionId)
    for (const form of forms) input = validateExtensionForm(form, input ?? {})
    const context = this.running.get(id)!
    for (const form of forms) {
      for (const field of form.fields) {
        const value = input?.[field.key]
        if (field.type === 'password' && typeof value === 'string') context.rememberSecret(value)
      }
    }
    const invocationId = randomUUID()
    const queue = { extensionId: id, items: [] as ExtensionTaskProposal[] }
    this.proposals.set(invocationId, queue)
    try {
      const result = context.redact(await this.host.invoke(id, actionId, input, invocationId, runId))
      const message = result && typeof result === 'object' && 'message' in result ? result.message : undefined
      const proposals = context.redact(queue.items)
      return { ok: true, ...(proposals.length ? { proposals } : {}), ...(typeof message === 'string' ? { message } : {}) }
    } catch (error) {
      throw new Error(context.redact(errorMessage(error, 'Extension command failed')))
    } finally {
      this.proposals.delete(invocationId)
    }
  }

  async close(): Promise<void> {
    this.isClosed = true
    clearInterval(this.reconcileTimer)
    for (const id of this.restarts.keys()) this.cancelRestart(id)
    for (const context of this.running.values()) context.disable()
    await ExtensionManager.catalogMutations.get(this.home)
    await this.chatMutations
    const ids = new Set([...this.running.keys(), ...this.chatCleanups.keys(), ...this.stopping.keys()])
    await Promise.all([...ids].map(id => this.stop(id)))
    for (const item of this.slots.values()) await item.registration.dispose()
    this.slots.clear()
    await Promise.all([...this.prepared.values()].map(preview => this.installer.discardInstall(preview.value)))
    this.prepared.clear()
    for (const timer of this.previewTimers.values()) clearTimeout(timer)
    this.previewTimers.clear()
    ExtensionManager.instances.delete(this)
    if (!this.peers().length) ExtensionManager.catalogMutations.delete(this.home)
  }
}
