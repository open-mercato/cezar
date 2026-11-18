// Worker half of the user-extension boundary. Runs as its own Node process (host.ts spawns it via
// worker-source.ts); stdout is reserved for bounded RPC frames. It may import node builtins only —
// it runs without the service's module graph, so types come in through `import type` alone.
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'
import type { ExtensionManifest } from '@open-mercato/cezar-contract'

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_PENDING_HOST_CALLS = 100
const MAX_QUEUED_EVENTS = 64
const MAX_CHAT_ADAPTERS = 20
const HOST_CALL_TIMEOUT_MS = 30_000

type Handler = (...args: unknown[]) => unknown
type Disposable = { dispose?(): unknown }
type ChatAdapter = Disposable & Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>
type ExtensionModule = {
  activate?(context: unknown): Promise<Disposable | undefined> | Disposable | undefined
  deactivate?(): unknown
}
type Declared = { id: string }
type HostPending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** An inbound frame before dispatch; `params` is the activate/invoke/chat payload the host built. */
type Frame = {
  type?: unknown
  requestId?: unknown
  generation?: unknown
  method?: unknown
  params?: any
  ok?: unknown
  result?: unknown
  error?: { message?: string }
  event?: unknown
}
type LoadedModule = ExtensionModule & { default?: ExtensionModule; extension?: ExtensionModule }

/** The same adapter/context lifecycle runs in workers and the trusted shipped facade. */
export function createExtensionRuntime(output: (frame: unknown) => void) {
const invocation = new AsyncLocalStorage<string | undefined>()
const commands = new Map<string, Handler>()
const panels = new Map<string, Handler>()
const forms = new Map<string, Handler>()
const chatProviders = new Map<string, Handler>()
const chatCalls = new Map<string, AbortController>()
const operationIds = new WeakMap<object, string>()
const adapters = new Map<string, Promise<ChatAdapter>>()
const pending = new Map<string, HostPending>()
const listeners = new Set<Handler>()
const events: unknown[] = []

let extension: ExtensionModule | undefined
let context: Readonly<Record<string, unknown>> | undefined
let generation: string | undefined
let manifest: ExtensionManifest | undefined
let disposed: Disposable | undefined
let stopping = false
let eventDelivery: Promise<void> | undefined
const activeWork = new Set<Promise<void>>()
let sequence = 0

function send(value: unknown) {
  const frame = JSON.stringify(value)
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('extension IPC frame exceeds 1 MiB')
  output(JSON.parse(frame))
}

async function deliverEvents() {
  while (events.length && !stopping) {
    const event = events.shift()
    for (const listener of [...listeners]) {
      if (stopping) break
      try { await listener(event) } catch { /* one listener never blocks the rest */ }
    }
  }
}

function request(method: string, params: unknown): Promise<unknown> {
  if (stopping) return Promise.reject(new Error('extension stopped'))
  if (pending.size >= MAX_PENDING_HOST_CALLS) return Promise.reject(new Error('too many pending host calls'))
  const invocationId = invocation.getStore()
  if (method === 'tasks.propose' && !invocationId) {
    return Promise.reject(new Error('Task proposals require a command invocation'))
  }
  const requestId = `host-${++sequence}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('host RPC timed out'))
    }, HOST_CALL_TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timer })
    try {
      send({ type: 'hostRequest', requestId, generation, method, params, ...(invocationId ? { invocationId } : {}) })
    } catch (error) {
      clearTimeout(timer)
      pending.delete(requestId)
      reject(error)
    }
  })
}

function register(map: Map<string, Handler>, allowed: readonly Declared[], id: string, handler: Handler) {
  if (stopping || !allowed.some(item => item.id === id)) throw new Error('extension contribution is not declared')
  if (map.has(id)) throw new Error('duplicate extension contribution')
  map.set(id, handler)
  return { dispose: async () => { if (map.get(id) === handler) map.delete(id) } }
}

const declaredCommands = (m: ExtensionManifest): Declared[] => m.contributes?.commands ?? []
const declaredPanels = (m: ExtensionManifest): Declared[] => m.contributes?.panels ?? []
const declaredForms = (m: ExtensionManifest) => m.contributes?.forms ?? []
const declaredChats = (m: ExtensionManifest): Declared[] => m.contributes?.chatProviders ?? []

function createContext(m: ExtensionManifest, base: Record<string, unknown>) {
  return Object.freeze({
    ...base,
    commands: { register: (id: string, handler: Handler) => register(commands, declaredCommands(m), id, handler) },
    panels: { register: (id: string, handler: Handler) => register(panels, declaredPanels(m), id, handler) },
    chat: { register: (id: string, factory: Handler) => register(chatProviders, declaredChats(m), id, factory) },
    forms: { register: (id: string, handler: Handler) => register(forms, declaredForms(m), id, handler) },
    tasks: {
      list: () => request('tasks.list', {}),
      get: (runId: string) => request('tasks.get', { runId }),
      propose: (input: unknown) => request('tasks.propose', input),
    },
    storage: {
      get: (key: string) => request('storage.get', { key }),
      set: (key: string, value: unknown) => request('storage.set', { key, value }),
    },
    secrets: {
      get: (key: string) => request('secrets.get', { key }),
      set: (key: string, value: string) => request('secrets.set', { key, value }),
    },
    logger: {
      info: (message: string) => request('logger.info', { message }),
      error: (message: string) => request('logger.error', { message }),
    },
    taskEvents: {
      subscribe: (handler: Handler) => {
        if (!m.capabilities.includes('taskEvents')) throw new Error('taskEvents capability is not declared')
        listeners.add(handler)
        return { dispose: async () => listeners.delete(handler) }
      },
    },
  })
}

async function activate(params: { entry: string; manifest: ExtensionManifest; context: Record<string, unknown> }, frameGeneration: string) {
  if (extension) throw new Error('already active')
  generation = frameGeneration
  manifest = params.manifest
  context = createContext(manifest, params.context)
  const module = await import(pathToFileURL(params.entry).href) as LoadedModule
  extension = module.default ?? module.extension ?? module
  disposed = (await extension.activate?.(context)) ?? undefined
  for (const declaration of declaredChats(manifest)) {
    if (!chatProviders.has(declaration.id)) throw new Error('chat provider has no factory')
  }
}

let deactivating: Promise<void> | undefined
function deactivate(): Promise<void> { return deactivating ??= deactivateOnce() }
async function deactivateOnce() {
  stopping = true
  for (const controller of chatCalls.values()) controller.abort()
  for (const call of pending.values()) {
    clearTimeout(call.timer)
    call.reject(new Error('extension stopped'))
  }
  pending.clear()
  // Cancellation precedes draining: activation/listeners may themselves be
  // waiting for a host response that the cancellation above must release.
  await Promise.allSettled([...activeWork])
  const failures: unknown[] = []
  const attempt = async (cleanup: () => unknown) => { try { await cleanup() } catch (error) { failures.push(error) } }
  for (const adapter of adapters.values()) await attempt(async () => (await adapter).dispose?.())
  adapters.clear()
  chatProviders.clear()
  await attempt(() => disposed?.dispose?.())
  await attempt(() => extension?.deactivate?.())
  commands.clear()
  panels.clear()
  forms.clear()
  listeners.clear()
  events.length = 0
  if (failures.length) throw new AggregateError(failures, 'extension cleanup failed')
}

async function invoke(m: ExtensionManifest, params: { actionId: string; input: unknown; invocationId?: string; runId?: string }) {
  const action = declaredCommands(m).find(item => item.id === params.actionId)
  if (!action) throw new Error('extension action is not declared')
  const handler = commands.get(action.id)
  if (!handler) throw new Error('extension command has no handler')
  // A task-located command sees the host-asserted run as `input.runId`.
  const input = params.runId ? { ...(params.input && typeof params.input === 'object' ? params.input : {}), runId: params.runId } : params.input
  return invocation.run(params.invocationId, async () => handler(input, context))
}

async function chat(params: { providerId: string; botHandle: string; credentialProfile?: string; credential: string; operation: string; input: any }, frameGeneration: unknown, requestId: string, signal: AbortSignal) {
  const { providerId, credential, operation, input } = params
  const factory = chatProviders.get(providerId)
  if (!factory) throw new Error('chat provider is not declared')
  const key = `${providerId}:${params.botHandle}`
  if (typeof params.botHandle !== 'string' || !params.botHandle) throw Error('Missing bot binding')
  if (operation === 'retire') {
    const adapter = adapters.get(key)
    if (adapter) { await (await adapter).dispose?.(); adapters.delete(key) }
    return
  }
  if (!adapters.has(key)) {
    if (adapters.size >= MAX_CHAT_ADAPTERS) throw new Error('too many chat connections')
    const creating = Promise.resolve().then(() => factory(JSON.parse(credential), params.credentialProfile ? Object.freeze({credentials:{accessToken:async (slot: string, operation: {assertActive(): Promise<void>}) => {
      await operation.assertActive()
      const activeRequest = operationIds.get(operation)
      if (!activeRequest) throw Error('Unknown credential operation')
      const result = await request('chat.service', {requestId:activeRequest,method:'accessToken',input:{slot}})
      await operation.assertActive()
      return result
    }}}) : undefined) as Promise<ChatAdapter>)
    adapters.set(key, creating)
    // A rejected factory is retried on the next call rather than cached.
    void creating.catch(() => { if (adapters.get(key) === creating) adapters.delete(key) })
  }
  const adapter = await adapters.get(key)!
  if (stopping || frameGeneration !== generation) throw new Error('stale generation')
  const operationContext = Object.freeze({
    signal,
    async assertActive() {
      signal.throwIfAborted()
      if (stopping || frameGeneration !== generation) throw new Error('stale generation')
      await request('chat.assertActive', {requestId})
      signal.throwIfAborted()
    },
  })
  operationIds.set(operationContext, requestId)
  await operationContext.assertActive()
  const run = (name: string, ...args: unknown[]) => {
    const method = adapter[name]
    if (typeof method !== 'function') throw new Error(`chat adapter has no ${name}`)
    return method.apply(adapter, [...args, operationContext])
  }
  switch (operation) {
    case 'identify': return run('identify')
    case 'inspect': return run('inspect', input.chatId)
    case 'send': return run('send', input.chatId, input.message)
    case 'clearButtons': return run('clearButtons', input)
    case 'acknowledge': return run('acknowledge', input.eventId, input.text)
    case 'isMember': return run('isMember', input.chatId, input.userId)
    case 'receiveSession': {
      const service = async (method: string, input?: unknown) => {
        await operationContext.assertActive()
        const result = await request('chat.service', {requestId,method,input})
        await operationContext.assertActive()
        return result
      }
      const receive = adapter.receiveSession
      if (!receive) throw new Error('Receive session unavailable')
      const receiveContext = Object.freeze({
        ...operationContext,
        checkpoint: () => service('checkpoint'),
        accept: (delivery: unknown) => service('accept', delivery),
        health: (value: unknown) => service('health', value),
        openInteraction: async (input: unknown) => {
          const {handle} = await service('openInteraction', input) as {handle:string}
          return Object.freeze({...operationContext,
            taskChoices: (query: string) => service('taskChoices', {handle,query}),
            dispose: () => service('disposeInteraction', {handle}),
          })
        },
      })
      operationIds.set(receiveContext, requestId)
      return receive.call(adapter, receiveContext)
    }
  }
  throw new Error('unknown chat operation')
}

/** `args` reach the provider only when the host sent some: a panel provider outside a task is
 *  called with no arguments; a task-located one gets `{ runId }`. */
async function contribution(declared: Declared[], handlers: Map<string, Handler>, id: unknown, kind: string, ...args: unknown[]) {
  const declaration = declared.find(item => item.id === id)
  if (!declaration) throw new Error(`extension ${kind} is not declared`)
  const handler = handlers.get(declaration.id)
  return handler ? handler(...args) : declaration
}

async function dispatch(frame: Frame): Promise<unknown> {
  if (frame.method === 'activate') {
    if (stopping) throw new Error('extension stopped')
    return activate(frame.params, String(frame.generation))
  }
  if (frame.generation !== generation) throw new Error('stale generation')
  if (frame.method === 'deactivate') return deactivate()
  if (stopping) throw new Error('extension stopped')
  const m = manifest!
  switch (frame.method) {
    case 'invoke': return invoke(m, frame.params)
    case 'chat': {
      const id = String(frame.requestId), controller = new AbortController()
      chatCalls.set(id, controller)
      try { return await chat(frame.params, frame.generation, id, controller.signal) }
      finally { chatCalls.delete(id) }
    }
    case 'form': return contribution(declaredForms(m), forms, frame.params.formId, 'form')
    case 'panel': return contribution(declaredPanels(m), panels, frame.params.panelId, 'panel', ...(typeof frame.params.runId === 'string' ? [{ runId: frame.params.runId }] : []))
  }
  throw new Error('unknown method')
}

function hostResponse(frame: Frame) {
  if (frame.generation !== generation) return
  const call = pending.get(String(frame.requestId))
  if (!call) return
  pending.delete(String(frame.requestId))
  clearTimeout(call.timer)
  if (frame.ok) call.resolve(frame.result)
  else call.reject(new Error(frame.error?.message ?? 'host call failed'))
}

function queueEvent(frame: Frame) {
  if (frame.generation !== generation || stopping) return
  // A host that outpaces the extension gets one resync marker instead of an unbounded queue.
  if (events.length >= MAX_QUEUED_EVENTS) {
    events.length = 0
    events.push({ type: 'resyncRequired' })
  } else events.push(frame.event)
  return eventDelivery ??= deliverEvents().finally(() => { eventDelivery = undefined })
}

async function handle(frame: Frame) {
  if (frame.type === 'cancel') { if (frame.generation === generation) chatCalls.get(String(frame.requestId))?.abort(); return }
  if (frame.type === 'hostResponse') return hostResponse(frame)
  if (frame.type === 'event') return queueEvent(frame)
  if (frame.type !== 'request' || typeof frame.requestId !== 'string') return
  const reply = { type: 'response', requestId: frame.requestId, generation: frame.generation }
  try {
    const result = await dispatch(frame)
    send({ ...reply, ok: true, result: frame.method === 'activate' || frame.method === 'deactivate' ? undefined : result })
  } catch (error) {
    const failure = (error as { failure?: unknown } | null)?.failure
    const message = error instanceof Error ? error.message : String(error)
    send({ ...reply, ok: false, error: { code: 'EXTENSION_ERROR', message, ...(failure ? { failure } : {}) } })
  }
}

return { handle(frame: Frame): Promise<void> {
  // Deactivation must not wait on itself. All executable activation, request
  // and listener work is otherwise part of the same retirement barrier.
  if (frame.method === 'deactivate') return handle(frame)
  const running = handle(frame)
  activeWork.add(running)
  void running.finally(() => activeWork.delete(running)).catch(() => undefined)
  return running
}, dispose: deactivate }
}

/** Process-only plumbing; importing this module never changes host stdio. */
export function startExtensionWorker() {
const output = process.stdout.write.bind(process.stdout)
// console.* follows this redirect, so its output reaches the bounded stderr tail.
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
const runtime = createExtensionRuntime(frame => { output(`${JSON.stringify(frame)}\n`) })
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  let end: number
  while ((end = buffer.indexOf(10)) !== -1) {
    if (end > MAX_FRAME_BYTES) process.exit(31)
    const line = buffer.subarray(0, end)
    buffer = buffer.subarray(end + 1)
    let frame: Frame
    try { frame = JSON.parse(line.toString()) as Frame } catch { process.exit(32) }
    void runtime.handle(frame)
  }
  if (buffer.length > MAX_FRAME_BYTES) process.exit(31)
})
process.stdin.on('end', () => process.exit(0))

}
