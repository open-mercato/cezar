import { createHash } from 'node:crypto'
import type { SecretStore } from '../workspace/secrets.ts'
import { redactSecrets } from '../core/secret-redaction.ts'
import { extensionTaskProposalSchema, extensionTaskSummarySchema } from '@open-mercato/cezar-contract'
import { extensionEmptyInputSchema, extensionStorageGetSchema, extensionStorageSetSchema, extensionSecretSetSchema, extensionLogInputSchema, extensionTaskGetSchema } from './protocol.ts'
import type { ExtensionPermission, ExtensionTaskEvent, ExtensionTaskProposal, ExtensionTaskSummary, ExtensionProposalReceipt } from '@open-mercato/cezar-contract'
import { ExtensionStorage, rememberExtensionSecret } from './data.ts'
import { ExtensionTaskEventBus } from './events.ts'
import { requireExtensionPermission } from './permissions.ts'

/** `tasks.list` answers the newest tasks only, so the reply always fits one 1 MiB IPC frame */
export const MAX_LISTED_TASKS = 500
/** Distinct secret values remembered for redaction per extension session. */
export const MAX_KNOWN_SECRETS = 256

export interface ExtensionContextDeps {
  dataDir: string
  projectId: string
  projectRoot: string
  extensionId: string
  permissions: readonly ExtensionPermission[]
  listTasks?: () => Promise<ExtensionTaskSummary[]>
  /** One task of THIS project by run id, or undefined — the only way an extension reaches a task
   *  (`tasks.get`, and the host's `runId` check before a task-located call). */
  getTask?: (runId: string) => Promise<ExtensionTaskSummary | undefined>
  proposeTask?: (input: ExtensionTaskProposal, invocationId?: string) => Promise<ExtensionProposalReceipt>
  secrets: SecretStore
  /** Return false when the sink suppresses a message; the RPC must not claim publication. */
  log?: (level: 'info' | 'error', message: string, extensionId: string) => void | boolean
  events?: ExtensionTaskEventBus
}

/** The host-side context passed to an extension. No project id or root can be selected by the
 * extension; they are fixed at construction and task proposals are intentionally not launches. */
export class ExtensionHostContext {
  readonly storage: ExtensionStorage
  readonly events: ExtensionTaskEventBus
  readonly projectId: string
  readonly projectRoot: string
  private active = true
  private readonly knownSecrets = new Set<string>()
  constructor(private readonly deps: ExtensionContextDeps) {
    this.projectId = deps.projectId; this.projectRoot = deps.projectRoot
    this.storage = new ExtensionStorage(deps.dataDir, deps.extensionId)
    this.events = deps.events ?? new ExtensionTaskEventBus()
  }
  private ensureActive() { if (!this.active) throw new Error('extension host context is disabled') }
  private permission(permission: ExtensionPermission) { this.ensureActive(); requireExtensionPermission(this.deps.permissions, permission) }
  async listTasks(): Promise<ExtensionTaskSummary[]> {
    this.permission('project.read')
    return (await this.deps.listTasks?.() ?? []).slice(0, MAX_LISTED_TASKS).map(task => ({ ...task, id: task.id.slice(0, 200), title: task.title.slice(0, 500) }))
  }
  /** The same public shape as one `listTasks()` item; `null` when this project has no such run. */
  async getTask(runId: string): Promise<ExtensionTaskSummary | null> {
    this.permission('project.read')
    const task = await this.deps.getTask?.(runId)
    return task ? { ...task, id: task.id.slice(0, 200), title: task.title.slice(0, 500) } : null
  }
  async proposeTask(input: ExtensionTaskProposal, invocationId?: string): Promise<ExtensionProposalReceipt> {
    this.permission('task.create')
    if (!this.deps.proposeTask) throw Error('task proposals are unavailable')
    return this.deps.proposeTask(input, invocationId)
  }
  subscribe(listener: (event: ExtensionTaskEvent) => void): () => void { this.permission('project.read'); return this.events.subscribe(listener) }
  async dispatch(method: string, input: unknown, signal: AbortSignal, invocationId?: string): Promise<unknown> {
    this.ensureActive()
    if (signal.aborted) throw new Error('extension stopped')
    switch (method) {
      case 'tasks.list':
        extensionEmptyInputSchema.parse(input)
        return (await this.listTasks()).map(task => extensionTaskSummarySchema.parse(task))
      case 'tasks.get': {
        const task = await this.getTask(extensionTaskGetSchema.parse(input).runId)
        return task ? extensionTaskSummarySchema.parse(task) : null
      }
      case 'tasks.propose': return this.proposeTask(extensionTaskProposalSchema.parse(input), invocationId)
      case 'storage.get': return this.storage.get(extensionStorageGetSchema.parse(input).key)
      case 'storage.set': {
        const { key, value } = extensionStorageSetSchema.parse(input)
        await this.storage.set(key, value, () => { this.ensureActive(); if (signal.aborted) throw Error('extension stopped') }); return null
      }
      case 'secrets.get':
      case 'secrets.set': {
        const parsed = extensionStorageGetSchema.parse(method === 'secrets.set' ? { key: extensionSecretSetSchema.parse(input).key } : input)
        const name = `EXTENSION_${createHash('sha256').update(`${this.deps.extensionId}\0${parsed.key}`).digest('hex').toUpperCase()}`
        const scope = { kind: 'project' as const, projectId: this.projectId, root: this.projectRoot }
        const store = this.deps.secrets
        if (method === 'secrets.set') {
          const { value } = extensionSecretSetSchema.parse(input)
          this.rememberSecret(value)
          await rememberExtensionSecret(this.deps.dataDir, this.deps.extensionId, name, () => { this.ensureActive(); if (signal.aborted) throw Error('extension stopped') })
          await store.set(scope, name, value, ['cezar'], () => { this.ensureActive(); if (signal.aborted) throw Error('extension stopped') }); return null
        }
        const entry = (await store.read(scope)).values[name]
        if (!entry || entry.audiences.length !== 1 || entry.audiences[0] !== 'cezar') return null
        this.rememberSecret(entry.value); return entry.value
      }
      case 'logger.info':
      case 'logger.error': {
        const { message } = extensionLogInputSchema.parse(input)
        let safe = message
        for (const value of this.knownSecrets) safe = safe.replaceAll(value, '[REDACTED]')
        if (this.deps.log?.(method === 'logger.info' ? 'info' : 'error', redactSecrets(safe, []), this.deps.extensionId) === false) {
          throw new Error('Extension log rate limit reached')
        }
        return null
      }
      default: throw new Error('unknown host operation')
    }
  }
  /** Most-recently-used first out: a value in use is re-remembered on every call, so the cap only
   *  forgets secrets the extension has stopped handling. */
  rememberSecret(value: string): void {
    if (!value) return
    this.knownSecrets.delete(value)
    this.knownSecrets.add(value)
    if (this.knownSecrets.size > MAX_KNOWN_SECRETS) this.knownSecrets.delete(this.knownSecrets.values().next().value!)
  }
  redact<T>(value: T): T {
    if (typeof value === 'string') {
      let safe: string = value
      for (const secret of this.knownSecrets) safe = safe.replaceAll(secret, '[REDACTED]')
      return redactSecrets(safe, []) as T
    }
    if (Array.isArray(value)) return value.map(item => this.redact(item)) as T
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redact(item)])) as T
    return value
  }
  disable(): void { this.active = false }

}
