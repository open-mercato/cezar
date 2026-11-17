// Host side of the user-extension boundary: one worker process per active extension, request /
// response RPC with deadlines, and bounded host calls back. Process plumbing is worker-process.ts.
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { extensionManifestSchema, chatFailureSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { extensionRpcResponseSchema, extensionHostRequestSchema, extensionInvokeCallSchema, extensionPanelCallSchema, extensionChatCallSchema, type ExtensionHostRequest } from './protocol.ts'
import { MAX_PENDING_CALLS } from './rpc.ts'
import { spawnWorkerProcess, type WorkerProcess } from './worker-process.ts'
import { workerSource } from './worker-source.ts'
import { trustedChatWorker } from './trusted-chat-worker.ts'
import type { ChatDeliveryArtifact } from './delivery-catalog.ts'

export type ExtensionInstance = {
  id: string
  manifest: ExtensionManifest
  entry: string
  projectId: string
  generation?: string
  trustedInProcess?: ChatDeliveryArtifact
  sanitize?: (value: unknown) => unknown
  /** An unexpected exit of an ACTIVATED worker. A failed activation only rejects `activate`. */
  onFailure?: (error: Error) => void
  dispatch?: (method: string, params: unknown, signal: AbortSignal, invocationId?: string) => Promise<unknown>
  subscribe?: (listener: (event: unknown) => void) => (() => void)
}

export type ExtensionCallOptions = { signal?: AbortSignal; valid?: () => boolean; authorize?: () => Promise<void>; service?: (method: string, input: unknown) => Promise<unknown> }

type Pending = { work: Set<Promise<void>>; service?: ExtensionCallOptions['service']; authorize?: () => Promise<void>; valid?: () => boolean; cleanup?: () => void; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }
type Session = {
  worker: Omit<WorkerProcess, 'child'> & { child?: WorkerProcess['child'] }
  drains: Map<string, () => void>
  receivers: Map<string, Promise<unknown>>
  pending: Map<string, Pending>
  generation: string
  controller: AbortController
  stopping: boolean
  failed?: boolean
  activated: boolean
  resyncPending: boolean
  ready?: Promise<void>
  stopped?: Promise<void>
  hostCalls: number
  work: Set<Promise<void>>
  unsubscribe?: () => void
}

const ACTIVATE_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 30_000
const DEACTIVATE_TIMEOUT_MS = 5_000
const HOST_ERROR = { code: 'HOST_ERROR', message: 'Host operation failed or access denied' }

export class ExtensionHost {
  constructor(private readonly execArgv: readonly string[] = []) {}
  private readonly sessions = new Map<string, Session>()

  async activate(instance: ExtensionInstance): Promise<void> {
    const source = instance.trustedInProcess ? '' : await workerSource()
    const existing = this.sessions.get(instance.id)
    if (existing) {
      if (existing.stopping || existing.failed) throw new Error('extension stopped')
      return existing.ready
    }
    const manifest = extensionManifestSchema.parse(instance.manifest)
    const session = this.spawn(instance, source)
    this.sessions.set(instance.id, session)
    const context = { projectId: instance.projectId, permissions: manifest.permissions }
    session.ready = this.call(session, 'activate', { entry: instance.entry, manifest, context }, ACTIVATE_TIMEOUT_MS)
      .then(() => {
        session.activated = true
        session.unsubscribe = instance.subscribe?.(event => this.publish(session, event))
      })
      .catch(async error => {
        await this.deactivate(instance.id)
        throw error
      })
    return session.ready
  }

  private spawn(instance: ExtensionInstance, source: string): Session {
    const label = `[extension ${instance.id}]`
    // The callbacks run only after spawn returns, by which time `session` is assigned.
    let session!: Session
    const worker = instance.trustedInProcess
      ? trustedChatWorker(instance.trustedInProcess, {onFrame: raw => this.onFrame(session, instance, raw), onExit: error => this.fail(session, instance, error)})
      : spawnWorkerProcess({
      label,
      args: [...this.execArgv, '--input-type=module', '-e', source],
      cwd: dirname(instance.entry),
      log: line => console.error(instance.sanitize ? instance.sanitize(line) : line),
      sanitizeStderr: text => String(instance.sanitize ? instance.sanitize(text) : text),
      onFrame: raw => this.onFrame(session, instance, raw),
      onExit: error => this.fail(session, instance, error),
      onExitDiagnostic: (error, tail) => {
        if (!session.stopping && tail) console.error(`${label} ${error.message}; last stderr:\n${tail}`)
      },
    })
    session = {
      worker,
      pending: new Map(),
      drains: new Map(),
      receivers: new Map(),
      generation: instance.generation ?? randomUUID(),
      controller: new AbortController(),
      stopping: false,
      activated: false,
      resyncPending: false,
      hostCalls: 0,
      work: new Set(),
    }
    const child = session.worker.child
    child?.stdin.on('drain', () => {
      if (!session.resyncPending) return
      session.resyncPending = false
      this.publish(session, { type: 'resyncRequired' })
    })
    return session
  }

  private fail(session: Session, instance: ExtensionInstance, error: Error) {
    session.unsubscribe?.()
    session.controller.abort()
    for (const drained of session.drains.values()) drained()
    session.drains.clear()
    this.rejectPending(session, error)
    if (this.sessions.get(instance.id) !== session) return
    const notify = !session.stopping && session.activated
    session.failed = true
    // Killing a worker does not cancel a host-side task effect already in progress.
    // Keep this generation installed until those effects have drained.
    void Promise.allSettled([...session.work]).then(() => {
      if (this.sessions.get(instance.id) !== session) return
      this.sessions.delete(instance.id)
      if (notify) instance.onFailure?.(error)
    })
  }

  /** Throwing here is a protocol error: the supervisor kills the worker. */
  private onFrame(session: Session, instance: ExtensionInstance, raw: unknown) {
    const request = extensionHostRequestSchema.safeParse(raw)
    if (request.success) {
      if (session.stopping || session.failed || request.data.generation !== session.generation) return
      if (++session.hostCalls > MAX_PENDING_CALLS) throw new Error('too many pending host calls')
      const parentId = (request.data.params as {requestId?:unknown})?.requestId
      const parent = (request.data.method === 'chat.service' || request.data.method === 'chat.assertActive') && typeof parentId === 'string' ? session.pending.get(parentId) : undefined
      const work = this.serve(session, instance, request.data)
      session.work.add(work); parent?.work.add(work)
      void work.finally(() => { session.hostCalls--; session.work.delete(work); parent?.work.delete(work) })
      return
    }
    // Invalid optional provider diagnostics must not invalidate an otherwise valid RPC error.
    if (raw && typeof raw === 'object' && 'error' in raw && raw.error && typeof raw.error === 'object'
      && 'failure' in raw.error && !chatFailureSchema.safeParse(raw.error.failure).success) delete raw.error.failure
    const response = extensionRpcResponseSchema.parse(raw)
    if (response.generation !== session.generation) return
    const pending = session.pending.get(response.requestId)
    if (!pending) { session.drains.get(response.requestId)?.(); return }
    session.worker.answered()
    session.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    pending.cleanup?.()
    const sanitize = instance.sanitize ?? (value => value)
    if (response.ok) {
      void Promise.allSettled([...pending.work]).then(() => pending.resolve(sanitize(response.result)))
      return
    }
    const message = String(sanitize(response.error?.message ?? 'extension call failed'))
    void Promise.allSettled([...pending.work]).then(() => pending.reject(Object.assign(new Error(message), response.error?.failure ? { failure: response.error.failure } : {})))
  }

  private async serve(session: Session, instance: ExtensionInstance, message: ExtensionHostRequest) {
    try {
      if (session.controller.signal.aborted) throw new Error('extension stopped')
      if (message.method === 'chat.assertActive' || message.method === 'chat.service') {
        const id = (message.params as { requestId?: unknown })?.requestId
        const call = typeof id === 'string' ? session.pending.get(id) : undefined
        if (!call || call.valid?.() === false) throw new Error('chat operation cancelled')
        await call.authorize?.()
        if (!session.pending.has(String(id)) || call.valid?.() === false) throw new Error('chat operation cancelled')
        const params = message.params as { method?: unknown; input?: unknown }
        const result = message.method === 'chat.service' && call.service && typeof params.method === 'string'
          ? await call.service(params.method, params.input) : undefined
        if (message.method === 'chat.service' && !call.service) throw new Error('Chat service unavailable')
        if (!session.pending.has(String(id)) || call.valid?.() === false) throw new Error('chat operation cancelled')
        this.respond(session, message.requestId, { ok: true, result })
        return
      }
      if (!instance.dispatch) throw new Error('host operation unavailable')
      const result = await instance.dispatch(message.method, message.params, session.controller.signal, message.invocationId)
      this.respond(session, message.requestId, { ok: true, result })
    } catch {
      this.respond(session, message.requestId, { ok: false, error: HOST_ERROR })
    }
  }

  private respond(session: Session, requestId: string, response: Record<string, unknown>) {
    if (session.controller.signal.aborted) return
    const frame = { type: 'hostResponse', requestId, generation: session.generation }
    try {
      session.worker.write({ ...frame, ...response })
    } catch {
      // An oversized reply is the host's problem, not the worker's: answer an error instead.
      try {
        session.worker.write({ ...frame, ok: false, error: { code: 'HOST_ERROR', message: 'Host response exceeds the IPC frame limit' } })
      } catch { session.worker.kill() }
    }
  }

  private publish(session: Session, event: unknown) {
    if (session.stopping || session.controller.signal.aborted) return
    // A backed-up worker gets one resync marker on drain instead of an unbounded queue.
    if (session.worker.congested) {
      session.resyncPending = true
      return
    }
    try { session.worker.write({ type: 'event', generation: session.generation, event }) } catch { session.worker.kill() }
  }

  /** `runId` is the host-asserted task of a `task`-located command; the manager resolves it
   *  through the project's own store before it gets here. */
  async invoke(id: string, actionId: string, input: unknown, invocationId?: string, runId?: string): Promise<unknown> {
    const params = extensionInvokeCallSchema.parse({ actionId, input, invocationId, ...(runId ? { runId } : {}) })
    return this.call(await this.active(id), 'invoke', params, CALL_TIMEOUT_MS)
  }

  async panel(id: string, panelId: string, runId?: string): Promise<unknown> {
    return this.call(await this.active(id), 'panel', extensionPanelCallSchema.parse({ panelId, ...(runId ? { runId } : {}) }), CALL_TIMEOUT_MS)
  }

  async form(id: string, formId: string): Promise<unknown> {
    return this.call(await this.active(id), 'form', { formId }, CALL_TIMEOUT_MS)
  }

  async chat(id: string, params: unknown, options: ExtensionCallOptions = {}): Promise<unknown> {
    return this.call(await this.active(id), 'chat', extensionChatCallSchema.parse(params), CALL_TIMEOUT_MS, options)
  }

  async receiveSession(id: string, params: unknown, options: ExtensionCallOptions): Promise<unknown> {
    const call = extensionChatCallSchema.parse(params)
    if (call.operation !== 'receiveSession') throw Error('Long-lived RPC requires receiveSession')
    const session = await this.active(id)
    const key = `${call.providerId}:${call.botHandle}`
    // A cooperative worker can finish before the host acceptance does. A new
    // receiver for this handle must still wait for the old host-side drain.
    while (session.receivers.has(key)) await session.receivers.get(key)!.catch(() => undefined)
    if (this.sessions.get(id) !== session || session.stopping || session.failed) throw new Error('extension stopped')
    const running = this.call(session, 'chat', call, undefined, options)
    session.receivers.set(key,running)
    try { return await running }
    finally { if (session.receivers.get(key) === running) session.receivers.delete(key) }

  }

  private async active(id: string): Promise<Session> {
    const session = this.sessions.get(id)
    if (!session || session.stopping || session.failed) throw new Error('extension is not active')
    await session.ready
    if (session.stopping || session.failed || this.sessions.get(id) !== session) throw new Error('extension is not active')
    return session
  }

  async deactivate(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    session.stopped ??= this.shutdown(id, session)
    return session.stopped
  }

  private async shutdown(id: string, session: Session) {
    session.stopping = true
    session.unsubscribe?.()
    session.controller.abort()
    this.rejectPending(session, new Error('extension stopped'))
    try { await this.call(session, 'deactivate', {}, DEACTIVATE_TIMEOUT_MS) } catch { /* stopped below */ }
    await session.worker.stop(0)
    await Promise.allSettled([...session.work])
    if (this.sessions.get(id) === session) this.sessions.delete(id)
  }

  private rejectPending(session: Session, error: Error) {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer)
      pending.cleanup?.()
      void Promise.allSettled([...pending.work]).then(() => pending.reject(error))
    }
    session.pending.clear()
  }

  private call(session: Session, method: string, params: unknown, timeout: number | undefined, options: ExtensionCallOptions = {}): Promise<unknown> {
    if (options.signal?.aborted || options.valid?.() === false) return Promise.reject(new Error('extension call cancelled'))
    if (session.pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error('too many pending extension calls'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const valid = () => !options.signal?.aborted && options.valid?.() !== false && !session.stopping && !session.failed
      const work = new Set<Promise<void>>()
      const rejectDrained = (error: Error) => { void Promise.allSettled([...work]).then(() => reject(error)) }
      const cancel = (error = new Error('extension call cancelled')) => {
        if (!session.pending.delete(requestId)) return
        cleanup()
        clearTimeout(timer)
        try { session.worker.write({type:'cancel',generation:session.generation,requestId}) } catch {}
        if (timeout === undefined) {
          const finish = () => { clearTimeout(drainTimer); session.drains.delete(requestId); rejectDrained(error) }
          const drainTimer = setTimeout(() => { void session.worker.stop(0).then(finish, finish) }, 1000)
          session.drains.set(requestId, finish)
        } else rejectDrained(error)
      }
      const fence = options.valid ? setInterval(() => { if (!valid()) cancel() }, 25) : undefined
      fence?.unref()
      const abort = () => cancel()
      const cleanup = () => { clearInterval(fence); options.signal?.removeEventListener('abort', abort) }
      options.signal?.addEventListener('abort', abort, {once:true})
      const timer = timeout === undefined ? undefined : setTimeout(() => {
        cancel(new Error('extension RPC timed out'))
        if (method !== 'deactivate') session.worker.timedOut()
      }, timeout)
      session.pending.set(requestId, { work, resolve, reject, timer, valid, cleanup, authorize: options.authorize, service: options.service })
      try {
        session.worker.write({ type: 'request', requestId, generation: session.generation, method, params })
      } catch (error) {
        clearTimeout(timer)
        cleanup()
        session.pending.delete(requestId)
        reject(error)
      }
    })
  }
}
