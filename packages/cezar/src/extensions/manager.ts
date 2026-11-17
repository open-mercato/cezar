import { pinArtifact } from './artifact-leases.ts'
import { withLifecycleFileLock } from '../worktree-lifecycle/store.ts'
import { existsSync } from 'node:fs'
import { realpath, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
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
import { cezarHomeDir } from '../paths.ts'
import { SecretStore } from '../workspace/secrets.ts'
import { addedCapabilities, addedPermissions, approved, keepsConsent } from './consent.ts'
import { ExtensionHostContext, type ExtensionContextDeps } from './context.ts'
import { ExtensionHost } from './host.ts'
import { commitPrepared, enabledProjects, uninstallExtension, uninstallImpact } from './install-transaction.ts'
import { contained } from './install-files.ts'
import { artifactIntegrity, ExtensionInstaller, isPackageSource, sourceIdentity, type PreparedInstall } from './installer.ts'
import { projectInventory } from './inventory.ts'
import { requireExtensionPermission } from './permissions.ts'
import { ExtensionStore, type UnreadableRecord } from './store.ts'
import { RestartBudget, type RestartBudgetOptions } from './worker-process.ts'

const declaredCommands = (manifest: ExtensionRecord['manifest']) => manifest.contributes?.commands ?? []
const declaredPanels = (manifest: ExtensionRecord['manifest']) => manifest.contributes?.panels ?? []
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

type ManagerDeps = Pick<ExtensionContextDeps, 'listTasks' | 'getTask' | 'proposeTask' | 'events' | 'log'> & {
  secrets?: SecretStore
  workerExecArgv?: readonly string[]
  home?: string
  /** Restart policy for a worker that dies after activation (defaults: 3 rapid crashes, 1 s backoff doubling). */
  restarts?: RestartBudgetOptions
}
type InvokeResult = { ok: boolean; message?: string; proposals?: ExtensionTaskProposal[] }
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
  private readonly proposals = new Map<string, { extensionId: string; items: ExtensionTaskProposal[] }>()
  private readonly failures = new Map<string, string>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly restarts = new Map<string, Restart>()
  private readonly previewTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Read-only views: helpers change state only through the intent-named methods below. */
  get closed(): boolean { return this.isClosed }
  get contexts(): ReadonlyMap<string, ExtensionHostContext> { return this.running }
  failure(id: string): string | undefined { return this.failures.get(id) }
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

  private readonly artifacts = new Map<string, string>()
  private readonly pins = new Map<string, () => Promise<void>>()
  private reconcileTimer?: ReturnType<typeof setInterval>
  private reconciledSignature?: string
  private readonly running = new Map<string, ExtensionHostContext>()
  private readonly prepared = new Map<string, { value: PreparedInstall; expiresAt: number }>()
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
      if (empty && !this.running.size && !(await this.catalog.list()).length) return empty()
      await mkdir(join(this.home, 'extensions'), { recursive: true, mode: 0o700 })
      return withLifecycleFileLock(join(this.home, 'extensions', '.manager.lock'), operation)
    })
    this.mutations = result.catch(() => undefined).finally(() => { if (notify) ExtensionManager.changed() })
    ExtensionManager.catalogMutations.set(this.home, this.mutations)
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

  private status(id: string): NonNullable<ExtensionRecord['status']> {
    if (this.restarts.get(id)?.timer) return 'starting'
    if (this.failures.has(id)) return 'failed'
    if (this.starting.has(id)) return 'starting'
    if (this.running.has(id)) return 'running'
    return 'disabled'
  }

  async list(): Promise<ExtensionRecord[]> {
    if (this.isClosed) return this.records()
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
    const files = [this.catalog.file, this.approvals.file]
    const stats = await Promise.all(files.map(file => stat(file).then(info => `${info.ino}:${info.mtimeMs}:${info.size}`, () => '')))
    return JSON.stringify([stats, [...this.running.keys()], [...this.failures.keys()]])
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
      if (!record.enabled || this.running.has(id) || this.failures.has(id) || this.restarts.get(id)?.timer) continue
      await this.start(record).catch(() => undefined)
      changed = true
    }
    if (retired.size || changed) ExtensionManager.changed()
    for (const id of retired) {
      await this.installer.pruneArtifacts(id, records.find(record => record.manifest.id === id)?.integrity).catch(() => undefined)
    }
  }

  async records(): Promise<ExtensionRecord[]> {
    const [{ records: installed, unreadable: lostInstalls }, { records: approvals, unreadable: lostApprovals }] = await Promise.all([this.catalog.snapshot(), this.approvals.snapshot()])
    this.reportRows(this.catalog, lostInstalls)
    this.reportRows(this.approvals, lostApprovals)
    return installed.map(record => {
      const id = record.manifest.id
      const status = this.status(id)
      const error = status === 'failed' ? this.failures.get(id) : undefined
      const approval = approvals.find(item => item.manifest.id === id)
      return { ...record, status, ...(error ? { error } : {}), enabled: !!record.integrity && approved(approval, record) }
    })
  }

  async installed(): Promise<ExtensionRecord[]> { return this.catalog.list() }

  /** Metadata reads never reconcile, create leases or activate extension code. */
  async inventory(unavailable?: 'flag-disabled' | 'hosted'): Promise<ExtensionInventoryItem[]> {
    const [{ records: installed, unreadable: lostInstalls }, { records: saved, unreadable: lostApprovals }] = await Promise.all([this.catalog.snapshot(), this.approvals.snapshot()])
    this.reportRows(this.catalog, lostInstalls)
    this.reportRows(this.approvals, lostApprovals)
    return projectInventory({ installed, saved, unavailable, status: id => this.status(id), failed: id => this.failures.has(id), lost: { installs: lostInstalls, approvals: lostApprovals } })
  }

  uninstallImpact(extensionId: string): Promise<ExtensionUninstallImpact> { return uninstallImpact(this, extensionId) }


  async prepareUpdate(id: string) {
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
    source = source.trim()
    if (!source) throw new Error('extension source must not be empty')
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

  async setEnabled(id: string, enabled: boolean, integrity?: string): Promise<ExtensionRecord | undefined> {
    return this.serialize(async () => {
      const record = (await this.records()).find(item => item.manifest.id === id)
      if (!record) return undefined
      if (enabled && integrity !== undefined && integrity !== record.integrity) {
        throw new Error('extension artifact changed; review its permissions again')
      }
      this.clearFailure(id)
      const next = { ...record, enabled }
      try {
        if (!enabled) await this.stop(id)
        await this.approve(next)
        if (enabled) await this.start(next)
      } catch (error) {
        await this.approve(record)
        if (!enabled && record.enabled) await this.start(record)
        throw error
      }
      return next
    })
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
    const stopping = (async () => {
      await this.host.deactivate(id)
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
        void this.serialize(restartOperation).catch(() => undefined)
      }, next.delayMs)
      restart.timer.unref()
      ExtensionManager.changed()
    })
  }
  private async activate(record: ExtensionRecord): Promise<void> {
    const id = record.manifest.id
    await this.stopping.get(id)
    if (this.isClosed) throw new Error('extension manager is closed')
    if (this.running.has(id)) return
    if (!record.integrity) throw new Error('reinstall this extension to create an immutable artifact')
    const digest = createHash('sha256').update(record.integrity).digest('hex')
    const root = await realpath(join(this.home, 'extensions', 'artifacts', id, record.manifest.version, digest))
    if (await artifactIntegrity(root) !== record.integrity) throw new Error('installed extension artifact changed; reinstall and review it')
    const entry = await realpath(resolve(root, record.manifest.entry))
    if (!contained(root, entry)) throw new Error('extension entry must stay inside its installed directory')
    if (this.isClosed) throw new Error('extension manager is closed')
    const release = await pinArtifact(this.home, id, digest, root)
    this.pins.set(id, release)
    this.artifacts.set(id, this.artifactKey(record))
    this.watchCatalog()
    const context = this.createContext(record)
    this.running.set(id, context)
    let restart = this.restarts.get(id)
    if (!restart) {
      restart = { budget: new RestartBudget(this.deps.restarts), startedAt: 0 }
      this.restarts.set(id, restart)
    }
    restart.startedAt = Date.now()
    try {
      await this.host.activate({
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
        dispatch: (method, params, signal, invocationId) => context.dispatch(method, params, signal, invocationId),
        ...(record.manifest.permissions.includes('project.read')
          ? { subscribe: (listener: (event: unknown) => void) => context.subscribe(listener) }
          : {}),
      })
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

  async restore(): Promise<void> {
    if (this.isClosed) return
    try {
      await this.serialize(async () => {
        const records = await this.records()
        if (records.length) this.watchCatalog()
        for (const record of records) {
          if (!record.enabled) continue
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
    const ids = new Set([...this.running.keys(), ...this.stopping.keys()])
    await Promise.all([...ids].map(id => this.stop(id)))
    await Promise.all([...this.prepared.values()].map(preview => this.installer.discardInstall(preview.value)))
    this.prepared.clear()
    for (const timer of this.previewTimers.values()) clearTimeout(timer)
    this.previewTimers.clear()
    ExtensionManager.instances.delete(this)
    if (!this.peers().length) ExtensionManager.catalogMutations.delete(this.home)
  }
}
