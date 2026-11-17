import { ExtensionChatError, type ChatReceiveSession, type ChatMessage, type ChatReceipt, type ChatEvent, type ExtensionChatAdapter, type ExtensionChatOperationContext } from '@open-mercato/cezar-extension-sdk/chat'
import { Agent, request as undiciRequest } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import WebSocket from 'ws'
import { z } from 'zod'
import { channelIdentity, parseChat, snowflake } from './identity.js'
import { discordChannelMember } from './membership.js'
import { discordApplicationCommands, discordCommandInteractionCallback } from './native-commands.js'
import { MAX_RESPONSE_BYTES as MAX, pinPublicAddress, pinnedConnect, publicTarget, readCapped, type Address, type Lookup } from './pinned-request.js'
import { abortableDelay, agentPool, remember, retryAfterMs, type AgentLease } from './adapter-support.js'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined
const fail = (kind: 'auth'|'conflict'|'rate_limited'|'gone'|'transient'|'blocked', retryAfterMs?: number) => new ExtensionChatError({ kind, ...(retryAfterMs ? { retryAfterMs } : {}) })
const MAX_QUEUE = 256, MAX_QUEUE_BYTES = 4 * MAX
export type DiscordRequestOptions = { lookup?: Lookup; request?: typeof undiciRequest }
// Discord limits per bucket and major parameter; only a global limit holds every route.
const major = (path: string) => /^\/(?:channels|guilds|webhooks|interactions)\/\d+/.exec(path)?.[0] ?? ''
const routeOf = (method: string, path: string) => { const head = major(path), rest = path.slice(head.length).replace(/\/\d+/g, '/:id'); return `${method} ${head}${head.startsWith('/interactions') ? rest.replace(/^\/[^/]+/, '/:token') : rest}` }
const REMEMBERED = 512
// Eviction must not free a live cooldown while expired ones remain; else the soonest to expire goes.
const cool = (map: Map<string, number>, key: string, until: number) => {
 map.delete(key)
 map.set(key, until)
 if (map.size <= 512) return
 const at = Date.now()
 for (const [k, v] of map) if (v <= at) map.delete(k)
 if (map.size > 512) map.delete([...map].reduce((a, b) => (b[1] < a[1] ? b : a))[0])
}
const header = (headers: Record<string, unknown> | undefined, name: string) => { const value = headers?.[name]; return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined }
/** `close` ends its pooled connections; a later call dials again. */
export type DiscordRequest = ((method: string, path: string, body?: unknown, operation?: ExtensionChatOperationContext) => Promise<unknown>) & { close?(): void }
export function discordRequest(token: string, options: DiscordRequestOptions = {}): DiscordRequest {
 const pool = agentPool(Agent)
 let globalUntil = 0
 const buckets = new Map<string, string>(), cooldowns = new Map<string, number>()
 return Object.assign(async (method: string, path: string, body?: unknown, operation?: ExtensionChatOperationContext) => {
  await operation?.assertActive(); operation?.signal.throwIfAborted()
  const route = routeOf(method, path), key = () => `${buckets.get(route) ?? route}|${major(path)}`
  // A cooldown stored under the route before its bucket hash was learned still applies.
  const until = (k: string) => { const t = cooldowns.get(k) ?? 0; if (t && t <= Date.now()) cooldowns.delete(k); return t }
  const wait = Math.max(globalUntil, until(`${route}|${major(path)}`), until(key()))
  if (Date.now() < wait) throw fail('rate_limited', wait - Date.now())
  // A POST whose outcome is unknown must not be retried: only reads are transient.
  const ambiguous = () => fail(method === 'GET' ? 'transient' : 'blocked')
  const controller = new AbortController(); const abort = () => controller.abort(); operation?.signal.addEventListener('abort', abort, { once: true }); let timer: ReturnType<typeof setTimeout> | undefined; let lease: AgentLease<Agent> | undefined
  try {
   const target = await pinPublicAddress('discord.com', options.lookup ?? (async h => dnsLookup(h, { all: true, verbatim: true })), controller.signal, 10000, fail); lease = pool.lease(target); const dispatcher = lease.agent
   await operation?.assertActive(); operation?.signal.throwIfAborted(); timer = setTimeout(abort, 10000)
   const response = await (options.request ?? undiciRequest)(`https://discord.com/api/v10${path}`, {
    method: method as any,
    dispatcher,
    signal: controller.signal,
    headersTimeout: 10000,
    bodyTimeout: 10000,
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   })
   const received = await readCapped(response.body, kind => kind === 'blocked' ? fail('blocked') : ambiguous(), controller.signal)
   let data: unknown; try { data = received.length ? JSON.parse(received.toString()) : undefined } catch { throw ambiguous() }
   const headers = response.headers as Record<string, unknown> | undefined
   const bucket = header(headers, 'x-ratelimit-bucket'); if (bucket && /^[\w-]{1,128}$/.test(bucket)) remember(buckets, route, bucket, REMEMBERED)
   const reset = Number(header(headers, 'x-ratelimit-reset-after')) * 1000
   if (header(headers, 'x-ratelimit-remaining') === '0' && reset > 0 && Number.isFinite(reset)) cool(cooldowns, key(), Date.now() + reset)
   if (response.statusCode === 429) {
    const limit = obj(data), wait = retryAfterMs(limit?.retry_after ?? header(headers, 'retry-after'))
    if (limit?.global === true || header(headers, 'x-ratelimit-global') === 'true') globalUntil = Date.now() + wait; else cool(cooldowns, key(), Date.now() + wait)
    throw fail('rate_limited', wait)
   }
   if (response.statusCode === 401) throw fail('auth'); if (response.statusCode === 404) throw fail('gone'); if (response.statusCode >= 500 || (response.statusCode >= 300 && response.statusCode < 400)) throw ambiguous(); if (response.statusCode >= 400) throw fail('blocked'); return data
  } catch (e) { if (e instanceof ExtensionChatError) throw e; throw operation?.signal.aborted ? fail('blocked') : ambiguous() } finally { lease?.release(); clearTimeout(timer); operation?.signal.removeEventListener('abort', abort) }
 }, { close: () => pool.close() })
}

const userSchema = z.object({ id: snowflake, username: z.string().min(1).max(128), bot: z.boolean().optional() })
const messageSchema = z.object({
 id: snowflake,
 channel_id: snowflake,
 guild_id: snowflake.optional(),
 author: userSchema,
 content: z.string().max(65536),
 timestamp: z.iso.datetime({ offset: true }),
 message_reference: z.object({ message_id: snowflake.optional(), channel_id: snowflake.optional() }).optional(),
 referenced_message: z.object({ id: snowflake, channel_id: snowflake, author: userSchema }).nullable().optional(),
})
const frameSchema = z.object({ op: z.number().int(), d: z.unknown().optional(), s: z.number().int().nonnegative().nullable().optional(), t: z.string().nullable().optional() })
const interactionSchema = z.object({
 id: snowflake,
 application_id: snowflake,
 type: z.union([z.literal(2), z.literal(3), z.literal(4)]),
 token: z.string().regex(/^[A-Za-z0-9_.-]{1,2048}$/),
 channel_id: snowflake,
 guild_id: snowflake.optional(),
 user: userSchema.optional(),
 member: z.object({ user: userSchema }).optional(),
 data: z
  .object({
   custom_id: z.string().min(1).max(100).optional(),
   component_type: z.literal(2).optional(),
   name: z.string().min(1).max(32).optional(),
   options: z
    .array(
     z.object({
      name: z.string(),
      focused: z.boolean().optional(),
      value: z.union([z.string(), z.number(), z.boolean()]),
     }),
    )
    .optional(),
  })
  .optional(),
 message: z
  .object({ id: snowflake, channel_id: snowflake, author: z.object({ id: snowflake, bot: z.boolean().optional() }) })
  .optional(),
})
const gatewaySchema = z.object({ url: z.string(), shards: z.number().int(), session_start_limit: z.object({ remaining: z.number().int(), reset_after: z.number().nonnegative().optional() }) })
type Interaction = z.infer<typeof interactionSchema>
export type DiscordSocketFactory = (url: string, options?: { lookup?: (...args: any[]) => void }) => WebSocket
// One platform cursor step; a row without an event durably skips a platform no-op.
type Batch = { sequence: number; event?: ChatEvent }[]
type Receiver = ExtensionChatAdapter & { receive(after: number | null, operation: ExtensionChatOperationContext): Promise<Batch> }
const HOLD_LIMIT_MS = 60000, HOLD_CAP = 100, ACK_DEADLINE_MS = 2500, DROP_REPORT_MS = 60000, RECONNECT_MS = 5000
// Discord interaction tokens stay valid for 15 minutes; keep a margin for the request itself.
const INTERACTION_TOKEN_MS = 14 * 60000
const CHANNEL_EVENTS = ['CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_UPDATE', 'THREAD_DELETE']
const COMMAND_RECEIVED = 'Command received. If you have access, Cezar replies in this chat.'
type Ack = { promise: Promise<void>; settled: boolean; failed: boolean }
type RecordState = { ack?: Ack; since?: number; heldUntil?: number; terminal?: string }
/** The session loop's batch pull; only tests may reach it. */
export function createDiscordReceiver(
 credentials: Record<string, string>,
 request = discordRequest(credentials.token ?? ''),
 socket?: DiscordSocketFactory,
 gatewayLookup: (host: string, signal?: AbortSignal) => Promise<Address[]> = async h =>
  dnsLookup(h, { all: true, verbatim: true }),
 reportTerminal: (message: string) => Promise<void> = async message => {
  console.error(message)
 },
): Receiver {
 let receiveContext: ChatReceiveSession | undefined
 let botId = ''
 let gatewaySequence: number | null = null
 let deliverySequence = 0
 let pending: Batch | undefined
 let queueBytes = 0
 let ws: WebSocket | undefined
 let disposed = false
 const lifecycle = new AbortController()
 let discoveryUrl = ''
 let resumeUrl: string | undefined
 let sessionId: string | undefined
 const queue: Json[] = []
 let wake: (() => void) | undefined
 let heartbeat: ReturnType<typeof setTimeout> | undefined
 let heartbeatAck = true
 let fatal: ExtensionChatError | undefined,
  reconnectAt = 0,
  startsRemaining = 0,
  startsResetAt = 0,
  commandsRegistered = false,
  commandsPending: Promise<void> | undefined
 // A record's receive state follows the bounded raw queue; platform payload fields cannot forge it.
 const conversion = new WeakMap<Json, RecordState>()
 const stateFor = (raw: Json) => {
  let state = conversion.get(raw)
  if (!state) {
   state = {}
   conversion.set(raw, state)
  }
  return state
 }
 const channels = new Map<string, ReturnType<typeof channelIdentity>>(),
  knownChannels = new Map<string, { id: string; kind: 'private' | 'group'; guild?: string }>(),
  commandReceipts = new Map<string, { applicationId: string; token: string }>(),
  buttonReceipts = new Map<string, { applicationId: string; token: string; expiresAt: number }>()
 const invoke = (m: string, p: string, b?: unknown, op?: ExtensionChatOperationContext) => request(m, p, b, op)
 const chat = async (id: string, op?: ExtensionChatOperationContext) => {
  let parsed: ReturnType<typeof parseChat>
  try {
   parsed = parseChat(id)
  } catch {
   throw fail('blocked')
  }
  const value = await invoke('GET', `/channels/${parsed.channel}`, undefined, op)
  let actual: ReturnType<typeof channelIdentity>
  try {
   actual = channelIdentity(value)
  } catch {
   throw fail('blocked')
  }
  if (actual.id !== id) throw fail('blocked')
  return actual
 }
 /** An inbound channel's identity, or undefined for one this bot cannot serve: never a session failure. */
 const lookupChannel = async (channelId: string, guildId: string | undefined, op?: ExtensionChatOperationContext) => {
  const hit = channels.get(channelId)
  if (hit && hit.channel.guild_id === guildId) return hit
  channels.delete(channelId)
  const value = await invoke('GET', `/channels/${channelId}`, undefined, op)
  let actual: ReturnType<typeof channelIdentity>
  try {
   actual = channelIdentity(value)
  } catch {
   return undefined
  }
  if (actual.channel.id !== channelId || actual.channel.guild_id !== guildId) return undefined
  remember(channels, channelId, actual, REMEMBERED)
  return actual
 }
 const mentionOf = () => new RegExp(`^<@!?${botId}>\\s*`)
 // A group hears only mentions and Replies to this bot, so other chatter needs no lookup and no queue slot.
 const relevant = (value: unknown) => {
  const parsed = messageSchema.safeParse(value)
  return (
   parsed.success &&
   !parsed.data.author.bot &&
   parsed.data.author.id !== botId &&
   (!parsed.data.guild_id ||
    mentionOf().test(parsed.data.content) ||
    parsed.data.referenced_message?.author.id === botId)
  )
 }
 const validGateway = (value: string) => {
  let u: URL
  try {
   u = new URL(value)
  } catch {
   throw fail('blocked')
  }
  if (
   u.protocol !== 'wss:' ||
   !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(u.hostname) ||
   u.port ||
   u.username ||
   u.password ||
   u.pathname !== '/'
  )
   throw fail('blocked')
  u.search = '?v=10&encoding=json'
  return u.toString()
 }
 const laneOf = (raw: Json) => {
  const id =
   raw.__type === 'MESSAGE_CREATE' || raw.__type === 'INTERACTION_CREATE'
    ? raw.channel_id
    : CHANNEL_EVENTS.includes(String(raw.__type))
      ? raw.id
      : undefined
  return typeof id === 'string' ? id : undefined
 }
 const exempt = (raw: Json) => CHANNEL_EVENTS.includes(String(raw.__type))
 const waiting = (raw: Json, now: number) => {
  const state = conversion.get(raw)
  return !!state && ((state.ack !== undefined && !state.ack.settled) || (state.heldUntil ?? 0) > now)
 }
 /** The first record whose chat is not parked: a parked head holds its chat, never the others. */
 const eligible = () => {
  const now = Date.now(),
   parked = new Set<string>()
  for (const raw of queue) {
   const lane = laneOf(raw)
   if (lane && parked.has(lane)) continue
   if (waiting(raw, now)) {
    if (lane) parked.add(lane)
    continue
   }
   return raw
  }
  return undefined
 }
 const parkedLanes = () => {
  const now = Date.now(),
   parked = new Set<string>()
  for (const raw of queue) {
   const lane = laneOf(raw)
   if (lane && waiting(raw, now)) parked.add(lane)
  }
  return parked
 }
 const parkedCount = (lanes = parkedLanes()) =>
  queue.filter(raw => {
   const lane = laneOf(raw)
   return lane && lanes.has(lane) && !exempt(raw)
  }).length
 const nextHold = () =>
  queue.reduce((soonest, raw) => {
   const until = conversion.get(raw)?.heldUntil ?? 0
   return until > Date.now() && until < soonest ? until : soonest
  }, Infinity)
 // Dropped input is reported as one bounded, id-free line per window.
 let drops = new Map<string, number>(),
  dropTimer: ReturnType<typeof setTimeout> | undefined
 const reportDrops = (rearm = true) => {
  dropTimer = undefined
  if (!drops.size) return
  const summary = [...drops].map(([what, count]) => `${count} ${what}`).join(', ')
  drops = new Map()
  void Promise.resolve()
   .then(() => reportTerminal(`Discord dropped held chat input (${summary}); Gateway resume cannot replay it.`))
   .catch(() => undefined)
  if (rearm) {
   dropTimer = setTimeout(reportDrops, DROP_REPORT_MS)
   dropTimer.unref?.()
  }
 }
 const dropped = (raw: Json, reason: 'cap' | 'budget') => {
  const what = `${raw.guild_id ? 'guild' : 'direct'} over the ${reason === 'cap' ? `${HOLD_CAP}-event hold cap` : `${HOLD_LIMIT_MS / 1000} s hold budget`}`
  drops.set(what, (drops.get(what) ?? 0) + 1)
  if (!dropTimer) reportDrops()
 }
 const stop = (reason: ExtensionChatError) => {
  fatal ??= reason
  ws?.terminate()
  wake?.()
  wake = undefined
 }
 /** Starts at ingress, off the queue: Discord's three-second deadline does not wait for earlier chats. */
 const acknowledgeInteraction = (raw: Json, event: Interaction, body: Json) => {
  const session = receiveContext,
   controller = new AbortController(),
   abort = () => controller.abort(),
   state = stateFor(raw)
  const deadline = Date.now() + ACK_DEADLINE_MS,
   limit = setTimeout(abort, ACK_DEADLINE_MS)
  lifecycle.signal.addEventListener('abort', abort, { once: true })
  session?.signal.addEventListener('abort', abort, { once: true })
  const operation: ExtensionChatOperationContext = {
   signal: controller.signal,
   assertActive: async () => {
    await session?.assertActive()
   },
  }
  const run = async () => {
   for (;;)
    try {
     await invoke('POST', `/interactions/${event.id}/${event.token}/callback`, body, operation)
     return
    } catch (error) {
     if (error instanceof ExtensionChatError && error.failure.kind === 'auth') {
      stop(error)
      throw error
     }
     if (!(error instanceof ExtensionChatError) || error.failure.kind !== 'rate_limited') throw error
     const retry = Math.max(error.failure.retryAfterMs ?? 1000, 50)
     if (Date.now() + retry >= deadline) throw error
     await abortableDelay(retry, controller.signal)
     if (controller.signal.aborted) throw error
    }
  }
  const ack: Ack = {
   settled: false,
   failed: false,
   promise: run()
    .catch(() => {
     ack.failed = true
    })
    .finally(() => {
     ack.settled = true
     clearTimeout(limit)
     lifecycle.signal.removeEventListener('abort', abort)
     session?.signal.removeEventListener('abort', abort)
     wake?.()
     wake = undefined
    }),
  }
  state.ack = ack
 }
 const interactionNeedsAck = (event: Interaction) => {
  const user = event.member?.user ?? event.user
  if (event.application_id !== botId || !user || user.bot) return undefined
  if (
   event.type === 3 &&
   event.data?.custom_id &&
   event.message?.author.id === botId &&
   event.message.channel_id === event.channel_id
  )
   return { type: 6 }
  if (event.type === 2 && event.data?.name === 'tasks') return { type: 5, data: { flags: 64 } }
  return undefined
 }
 const discover = async (op?: ExtensionChatOperationContext) => {
  const parsed = gatewaySchema.safeParse(await invoke('GET', '/gateway/bot', undefined, op))
  if (!parsed.success || parsed.data.shards > 1) throw fail('blocked')
  discoveryUrl = validGateway(parsed.data.url)
  startsRemaining = parsed.data.session_start_limit.remaining
  startsResetAt = Date.now() + (parsed.data.session_start_limit.reset_after ?? 60000)
 }
 const registerCommands = () => {
  const session = receiveContext
  if (commandsRegistered || !session) return
  commandsRegistered = true
  // Never gates receiving, and is retried after a failure: this route has a tight daily budget.
  commandsPending = invoke('PUT', `/applications/${botId}/commands`, discordApplicationCommands(), session).then(
   () => undefined,
   () => {
    commandsRegistered = false
   },
  )
 }
 const connect = async (op?: ExtensionChatOperationContext) => {
  const gatewayUrl = resumeUrl ?? discoveryUrl
  const host = new URL(gatewayUrl).hostname
  const lookupController = new AbortController()
  let timedOut = false
  let lookupTimer: ReturnType<typeof setTimeout> | undefined
  const abortLookup = () => lookupController.abort()
  const rejectLookup = (reject: (error: unknown) => void) => {
   lookupController.abort()
   reject(fail(timedOut ? 'transient' : 'blocked'))
  }
  if (disposed || lifecycle.signal.aborted || op?.signal.aborted) throw fail('blocked')
  lifecycle.signal.addEventListener('abort', abortLookup, { once: true })
  op?.signal.addEventListener('abort', abortLookup, { once: true })
  let addresses: Address[]
  try {
   addresses = await new Promise<Address[]>((resolve, reject) => {
    const onAbort = () => rejectLookup(reject)
    lookupController.signal.addEventListener('abort', onAbort, { once: true })
    if (lifecycle.signal.aborted || op?.signal.aborted) return onAbort()
    lookupTimer = setTimeout(() => {
     timedOut = true
     onAbort()
    }, 10000)
    Promise.resolve()
     .then(() => gatewayLookup(host, lookupController.signal))
     .then(resolve, reject)
   })
  } finally {
   if (lookupTimer) clearTimeout(lookupTimer)
   lifecycle.signal.removeEventListener('abort', abortLookup)
   op?.signal.removeEventListener('abort', abortLookup)
  }
  const target = publicTarget(addresses, fail)
  heartbeatAck = true
  const { lookup } = pinnedConnect(target)
  ws = (
   socket ??
   ((u, options) => new WebSocket(u, { handshakeTimeout: 10000, maxPayload: MAX, lookup: options?.lookup as any }))
  )(gatewayUrl, { lookup })
  const connection = ws
  let accepting = true
  let settled = false
  let graceful = false
  // Opcode 7 asks the client to reconnect and resume immediately; only an unrequested drop waits.
  let requested = false
  let timer: ReturnType<typeof setTimeout>
  await new Promise<void>((resolve, reject) => {
   const finish = (error?: unknown) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    op?.signal.removeEventListener('abort', cancel)
    lifecycle.signal.removeEventListener('abort', cancel)
    if (error) reject(error)
    else resolve()
   }
   const cancel = () => {
    finish(fail('blocked'))
    connection.terminate()
   }
   op?.signal.addEventListener('abort', cancel, { once: true })
   lifecycle.signal.addEventListener('abort', cancel, { once: true })
   // After the handshake settled, nothing awaits this connection: surface the failure through the receive loop.
   const refuse = (error: ExtensionChatError) => {
    if (settled) stop(error)
    else {
     finish(error)
     connection.terminate()
    }
   }
   timer = setTimeout(() => {
    connection.terminate()
    finish(fail('transient'))
   }, 15000)
   connection.once('open', () => {})
   connection.on('error', () => finish(fail('transient')))
   connection.on('close', (code?: number) => {
    accepting = false
    if (ws === connection) {
     ws = undefined
     reconnectAt = requested ? 0 : Date.now() + RECONNECT_MS
    }
    clearTimeout(heartbeat)
    wake?.()
    wake = undefined
    if (code === 4007 || code === 4009) {
     sessionId = undefined
     resumeUrl = undefined
     gatewaySequence = null
    }
    const closed =
     code === 4004
      ? fail('auth')
      : code !== undefined && [4010, 4011, 4012, 4013, 4014].includes(code)
        ? fail('blocked')
        : undefined
    if (closed) {
     if (settled) stop(closed)
     else finish(closed)
    } else if (!settled) finish(graceful ? undefined : fail('transient'))
   })
   connection.on('message', raw => {
    if (!accepting) return
    let frame: z.infer<typeof frameSchema>
    try {
     frame = frameSchema.parse(JSON.parse(raw.toString()))
    } catch {
     refuse(fail('blocked'))
     return
    }
    if (frame.op === 11) {
     heartbeatAck = true
     return
    }
    if (frame.op === 1) {
     connection.send(JSON.stringify({ op: 1, d: gatewaySequence }))
     return
    }
    if (frame.op === 10) {
     const hello = z.object({ heartbeat_interval: z.number().int().min(100).max(120000) }).safeParse(frame.d)
     if (!hello.success) return refuse(fail('blocked'))
     const beat = () => {
      if (!heartbeatAck) {
       connection.terminate()
       return
      }
      heartbeatAck = false
      connection.send(JSON.stringify({ op: 1, d: gatewaySequence }))
      heartbeat = setTimeout(beat, hello.data.heartbeat_interval)
     }
     clearTimeout(heartbeat)
     heartbeat = setTimeout(beat, Math.random() * hello.data.heartbeat_interval)
     if (!sessionId && --startsRemaining < 0) return refuse(fail('blocked'))
     connection.send(
      JSON.stringify({
       op: sessionId ? 6 : 2,
       d: sessionId
        ? { token: credentials.token, session_id: sessionId, seq: gatewaySequence }
        : {
           token: credentials.token,
           intents: 1 | 512 | 4096 | 32768,
           properties: { os: 'cezar', browser: 'cezar', device: 'cezar' },
          },
      }),
     )
     return
    }
    if (frame.op === 7 || frame.op === 9) {
     if (frame.op === 9 && frame.d !== true) {
      sessionId = undefined
      resumeUrl = undefined
      gatewaySequence = null
     }
     graceful = true
     requested = frame.op === 7
     connection.close()
     return
    }
    if (frame.op !== 0 || frame.s == null || !Number.isSafeInteger(frame.s)) return
    if (frame.t === 'READY') {
     const ready = obj(frame.d),
      user = obj(ready?.user),
      sid = ready?.session_id
     if (
      typeof user?.id !== 'string' ||
      user.bot !== true ||
      typeof sid !== 'string' ||
      !sid ||
      (botId && user.id !== botId)
     )
      return refuse(fail('auth'))
     let resume: string | undefined
     try {
      resume = typeof ready?.resume_gateway_url === 'string' ? validGateway(ready.resume_gateway_url) : undefined
     } catch (error) {
      return refuse(error as ExtensionChatError)
     }
     botId = user.id
     sessionId = sid
     resumeUrl = resume
     gatewaySequence = frame.s
     knownChannels.clear()
     channels.clear()
     clearTimeout(timer)
     registerCommands()
     finish()
     return
    }
    if (frame.t === 'RESUMED') {
     gatewaySequence = frame.s
     clearTimeout(timer)
     finish()
     return
    }
    if (gatewaySequence !== null && frame.s <= gatewaySequence) return
    const data = obj(frame.d) ?? {},
     type = frame.t ?? '',
     bytes = Buffer.byteLength(raw.toString())
    // Stop before consuming the overflowing dispatch; RESUME replays from the retained prefix.
    if (queue.length >= MAX_QUEUE || queueBytes + bytes > MAX_QUEUE_BYTES) {
     accepting = false
     graceful = true
     connection.terminate()
     return
    }
    gatewaySequence = frame.s
    if (CHANNEL_EVENTS.includes(type)) {
     const id = snowflake.safeParse(data.id)
     if (id.success) channels.delete(id.data)
    }
    // Chatter the core ignores needs no order and must not consume the cap.
    if (type === 'MESSAGE_CREATE' && !relevant(data)) return
    const record: Json = { ...data, __type: type, __bytes: bytes, __seq: frame.s },
     lane = laneOf(record),
     lanes = parkedLanes()
    if (lane && lanes.has(lane)) {
     // The cache is already invalidated, so one queued removal per type keeps the lane bounded.
     if (exempt(record)) {
      if (queue.some(item => laneOf(item) === lane && item.__type === type)) return
     } else if (parkedCount(lanes) >= HOLD_CAP) {
      dropped(record, 'cap')
      return
     } else stateFor(record).since = Date.now()
    }
    if (type === 'INTERACTION_CREATE') {
     const parsed = interactionSchema.safeParse(data)
     const body = parsed.success ? interactionNeedsAck(parsed.data) : undefined
     if (parsed.success && body) acknowledgeInteraction(record, parsed.data, body)
    }
    queue.push(record)
    queueBytes += bytes
    wake?.()
    wake = undefined
   })
  })
 }
 const next = async (op?: ExtensionChatOperationContext): Promise<Json | undefined> => {
  const deadline = Date.now() + 24000
  for (;;) {
   await op?.assertActive()
   op?.signal.throwIfAborted()
   if (disposed) throw fail('blocked')
   const head = eligible()
   if (head) return head
   if (fatal) throw fatal
   const remaining = deadline - Date.now()
   if (remaining <= 0) return undefined
   if (!ws && Date.now() >= reconnectAt) {
    if (!sessionId) {
     // The identify budget refills after reset_after (a minute when Discord omits it); then refresh it.
     if (!discoveryUrl || (startsRemaining < 1 && Date.now() >= startsResetAt)) await discover(op)
     if (startsRemaining < 1) {
      reconnectAt = Math.max(startsResetAt, Date.now() + 1000)
      await receiveContext?.health({ state: 'backoff' })
      continue
     }
    }
    await connect(op)
    // A batch delivered between sockets reported backoff; the live socket must clear it now, not after the next batch.
    if (ws) await receiveContext?.health({ state: 'polling' })
    continue
   }
   await new Promise<void>((resolve, reject) => {
    let done = false
    const finish = (error?: unknown) => {
     if (done) return
     done = true
     clearTimeout(timer)
     op?.signal.removeEventListener('abort', abort)
     lifecycle.signal.removeEventListener('abort', abort)
     if (wake === onWake) wake = undefined
     error ? reject(error) : resolve()
    }
    const abort = () => finish(fail('blocked'))
    const onWake = () => finish()
    const wakeAt = Math.min(deadline, nextHold(), ws ? Infinity : reconnectAt)
    const timer = setTimeout(onWake, Math.max(wakeAt - Date.now(), 1))
    wake = onWake
    op?.signal.addEventListener('abort', abort, { once: true })
    lifecycle.signal.addEventListener('abort', abort, { once: true })
    if (disposed || op?.signal.aborted) abort()
   })
  }
 }
 const finishCommand = async (
  receipt: { applicationId: string; token: string },
  op?: ExtensionChatOperationContext,
 ) => {
  await invoke(
   'PATCH',
   `/webhooks/${receipt.applicationId}/${receipt.token}/messages/@original`,
   { content: COMMAND_RECEIVED, allowed_mentions: { parse: [] } },
   op,
  ).catch(() => undefined)
 }
 const commandReceiptOf = (raw: Json) => {
  const parsed = raw.__type === 'INTERACTION_CREATE' ? interactionSchema.safeParse(raw) : undefined
  return parsed?.success &&
   parsed.data.type === 2 &&
   parsed.data.data?.name === 'tasks' &&
   conversion.get(raw)?.ack &&
   !conversion.get(raw)!.ack!.failed
   ? { applicationId: parsed.data.application_id, token: parsed.data.token }
   : undefined
 }
 const convert = async (
  raw: Json,
  sequence: number,
  op?: ExtensionChatOperationContext,
 ): Promise<Batch> => {
  const type = String(raw.__type),
   none = [{ sequence }]
  if (type === 'GUILD_CREATE') {
   const guild = z.object({ id: snowflake, channels: z.array(z.unknown()) }).safeParse(raw)
   if (guild.success)
    for (const item of guild.data.channels) {
     try {
      const known = channelIdentity({ ...(item as object), guild_id: guild.data.id })
      knownChannels.set(known.channel.id, { id: known.id, kind: known.kind, guild: guild.data.id })
     } catch {
      /* Unsupported channel. */
     }
    }
   return none
  }
  if (type === 'GUILD_DELETE' || type === 'CHANNEL_DELETE') {
   const removed = z.object({ id: snowflake, unavailable: z.boolean().optional() }).safeParse(raw)
   if (!removed.success || removed.data.unavailable) return none
   if (type === 'GUILD_DELETE')
    for (const [id, known] of channels) if (known.channel.guild_id === removed.data.id) channels.delete(id)
   const rows: Batch = []
   for (const [channel, known] of knownChannels)
    if (type === 'GUILD_DELETE' ? known.guild === removed.data.id : channel === removed.data.id) {
     rows.push({
      sequence: sequence + rows.length,
      event: {
       kind: 'membership',
       id: `removed:${removed.data.id}:${channel}:${raw.__seq}`,
       chat: { id: known.id, kind: known.kind },
       reason: 'removed',
      },
     })
     knownChannels.delete(channel)
    }
   return rows.length ? rows : none
  }
  if (type === 'INTERACTION_CREATE') {
   const parsed = interactionSchema.safeParse(raw)
   const user = parsed.success ? (parsed.data.member?.user ?? parsed.data.user) : undefined
   if (!parsed.success || !user || user.bot || parsed.data.application_id !== botId) return none
   const event = parsed.data,
    chatKey = `discord:${event.guild_id ? `guild:${event.guild_id}:${event.channel_id}` : `dm:${event.channel_id}`}`
   if (event.type === 4) {
    if (event.data?.name !== 'tasks') return none
    let choices: { name: string; value: string }[] = []
    const focused = event.data.options?.find(option => option.focused && option.name === 'task')
    if (!focused) return none
    if (receiveContext && String(focused.value).length <= 128) {
     const session = receiveContext
     let timer: ReturnType<typeof setTimeout> | undefined
     const lookup = async () => {
      const interaction = await session.openInteraction({
       kind: 'task-autocomplete',
       eventId: `interaction:${event.id}`,
       chat: { id: chatKey, kind: event.guild_id ? 'group' : 'private' },
       user: { id: user.id, label: user.username },
       at: Date.now(),
      })
      try {
       return await interaction.taskChoices(String(focused.value))
      } finally {
       await interaction.dispose()
      }
     }
     try {
      choices = await Promise.race([
       lookup(),
       new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('autocomplete deadline')), 1000)
       }),
      ])
     } catch {
     } finally {
      clearTimeout(timer)
     }
    }
    await op?.assertActive()
    await invoke(
     'POST',
     `/interactions/${event.id}/${event.token}/callback`,
     discordCommandInteractionCallback(choices),
     op,
    )
    return none
   }
   const state = conversion.get(raw)
   if (!state?.ack || state.ack.failed) return none
   if (event.type === 3) {
    const known = await lookupChannel(event.channel_id, event.guild_id, op)
    if (!known) return none
    remember(
     buttonReceipts,
     `interaction:${event.id}`,
     { applicationId: event.application_id, token: event.token, expiresAt: Date.now() + INTERACTION_TOKEN_MS },
     REMEMBERED,
    )
    return [
     {
      sequence,
      event: {
       kind: 'button',
       id: `interaction:${event.id}`,
       chat: { id: known.id, kind: known.kind },
       user: { id: user.id, label: user.username, username: user.username },
       receipt: { chatId: known.id, messageId: event.message!.id },
       data: event.data!.custom_id!,
      },
     },
    ]
   }
   const known = await lookupChannel(event.channel_id, event.guild_id, op)
   const receipt = { applicationId: event.application_id, token: event.token }
   if (!known) {
    await finishCommand(receipt, op)
    return none
   }
   const argument = event.data?.options?.find(option => option.name === 'task')?.value
   const text = typeof argument === 'string' && argument ? `/status ${argument}` : '/tasks'
   remember(commandReceipts, `interaction:${event.id}`, receipt, REMEMBERED)
   return [
    {
     sequence,
     event: {
      kind: 'message',
      id: `interaction:${event.id}`,
      chat: { id: known.id, kind: known.kind },
      user: { id: user.id, label: user.username, username: user.username },
      at: Date.now(),
      messageId: event.id,
      text,
      addressed: true,
     },
    },
   ]
  }
  if (type !== 'MESSAGE_CREATE') return none
  const parsed = messageSchema.safeParse(raw)
  if (!parsed.success || parsed.data.author.bot || parsed.data.author.id === botId) return none
  const message = parsed.data,
   known = await lookupChannel(message.channel_id, message.guild_id, op)
  if (!known) return none
  const mention = mentionOf(),
   reply =
    message.referenced_message?.author.id === botId &&
    message.referenced_message.channel_id === message.channel_id &&
    message.message_reference?.channel_id === message.channel_id &&
    message.message_reference.message_id === message.referenced_message.id
  if (known.kind === 'group' && !mention.test(message.content) && !reply) return none
  knownChannels.set(known.channel.id, {
   id: known.id,
   kind: known.kind,
   ...(known.channel.guild_id ? { guild: known.channel.guild_id } : {}),
  })
  return [
   {
    sequence,
    event: {
     kind: 'message',
     id: `message:${message.id}`,
     chat: { id: known.id, kind: known.kind },
     user: { id: message.author.id, label: message.author.username, username: message.author.username },
     at: Date.parse(message.timestamp),
     messageId: message.id,
     text: message.content.replace(mention, ''),
     addressed: known.kind === 'private' || mention.test(message.content),
     ...(reply ? { replyTo: { chatId: known.id, messageId: message.referenced_message!.id } } : {}),
    },
   },
  ]
 }
 const self: Receiver = {
  async identify(op) {
   const me = obj(await invoke('GET', '/users/@me', undefined, op))
   if (!me || !snowflake.safeParse(me.id).success || me.bot !== true) throw fail('auth')
   botId = me.id as string
   return { id: botId, username: botId, discoveryUrl: 'https://discord.com/developers/applications' }
  },
  async inspect(id, op) {
   const c = await chat(id, op)
   return { id, kind: c.kind, eligible: true }
  },
  async send(id, message: ChatMessage, op) {
   if (
    !message.text ||
    message.text.length > 2000 ||
    (message.buttons?.flat().length ?? 0) > 25 ||
    message.buttons?.flat().some(button => button.text.length > 80 || button.data.length > 100)
   )
    throw fail('blocked')
   const c = await chat(id, op)
   const components = (message.buttons ?? [])
    .flat()
    .reduce((rows: Json[][], b: { text: string; data: string }, i: number) => {
     const row = Math.floor(i / 5)
     ;(rows[row] ??= []).push({ type: 2, style: 1, label: b.text, custom_id: b.data })
     return rows
    }, [] as Json[][])
    .map((components: Json[]) => ({ type: 1, components }))
   const result = obj(
    await invoke(
     'POST',
     `/channels/${c.channel.id}/messages`,
     { content: message.text, allowed_mentions: { parse: [], replied_user: false }, flags: 4, components },
     op,
    ),
   )
   if (!snowflake.safeParse(result?.id).success || result!.channel_id !== c.channel.id) throw fail('blocked')
   return { chatId: id, messageId: result!.id as string }
  },
  async clearButtons(receipt: ChatReceipt, op) {
   if (!snowflake.safeParse(receipt.messageId).success) throw fail('blocked')
   const c = await chat(receipt.chatId, op)
   await invoke(
    'PATCH',
    `/channels/${c.channel.id}/messages/${receipt.messageId}`,
    { components: [], allowed_mentions: { parse: [] } },
    op,
   )
  },
  // Components are deferred at ingress (type 6), so @original IS the button's message; the
  // tapper's answer is an ephemeral follow-up instead, Discord's counterpart of a callback toast.
  async acknowledge(eventId, text, op) {
   const receipt = buttonReceipts.get(eventId)
   buttonReceipts.delete(eventId)
   if (!receipt || receipt.expiresAt <= Date.now() || !text) return
   await invoke(
    'POST',
    `/webhooks/${receipt.applicationId}/${receipt.token}`,
    { content: text.slice(0, 2000), flags: 64, allowed_mentions: { parse: [] } },
    op,
   )
  },
  async isMember(id, userId, op) {
   try {
    if (!snowflake.safeParse(userId).success) return undefined
    const c = await chat(id, op)
    if (c.kind === 'private') return c.channel.recipients?.some(x => x.id === userId)
    return await discordChannelMember((m, p, b) => invoke(m, p, b, op), c.channel.id, c.channel.guild_id!, userId)
   } catch (e) {
    if (e instanceof ExtensionChatError && e.failure.kind === 'gone') return false
    return undefined
   }
  },
  async receive(after, op): Promise<Batch> {
   await op?.assertActive()
   op?.signal.throwIfAborted()
   if (disposed) throw fail('blocked')
   if (after !== null && Number.isSafeInteger(after)) deliverySequence = Math.max(deliverySequence, after)
   if (pending && (after === null || after < pending[0]!.sequence)) return pending
   // The returned row remains replayable until the host reports its durable checkpoint.
   pending = undefined
   const raw = await next(op)
   if (!raw) return []
   if (!Number.isSafeInteger(deliverySequence + 1)) throw fail('blocked')
   const state = stateFor(raw)
   let batch: Batch
   try {
    if (state.terminal) throw fail('gone')
    batch = await convert(raw, deliverySequence + 1, op)
   } catch (error) {
    // Cancellation and revoked authorization never acknowledge the record.
    await op?.assertActive()
    op?.signal.throwIfAborted()
    if (
     disposed ||
     !(error instanceof ExtensionChatError) ||
     error.failure.kind === 'auth' ||
     error.failure.kind === 'conflict'
    )
     throw error
    if (error.failure.kind === 'rate_limited') {
     // Parked off the queue, so other chats keep flowing; past the budget or cap only this record is lost.
     const wait = Math.max(error.failure.retryAfterMs ?? 1000, 50)
     state.since ??= Date.now()
     const inBudget = Date.now() - state.since + wait <= HOLD_LIMIT_MS
     if (inBudget && parkedCount() <= HOLD_CAP) {
      state.heldUntil = Date.now() + wait
      // Whatever already queued behind it joined the parked lane now; later arrivals are stamped at ingress.
      const lane = laneOf(raw)
      if (lane)
       for (const item of queue) if (laneOf(item) === lane && !exempt(item)) stateFor(item).since ??= Date.now()
      return []
     }
     dropped(raw, inBudget ? 'cap' : 'budget')
     batch = [{ sequence: deliverySequence + 1 }]
    } else {
     // A per-record failure loses only this input. Report before the row can be checkpointed.
     state.terminal ??= error.failure.kind
     const id = snowflake.safeParse(raw.id)
     try {
      await reportTerminal(
       `Discord record ${id.success ? id.data : 'unknown'}: ${state.terminal}; action not processed. Submit it again if still needed.`,
      )
     } catch {
      throw fail('transient')
     }
     batch = [{ sequence: deliverySequence + 1 }]
    }
    const receipt = commandReceiptOf(raw)
    if (receipt) await finishCommand(receipt, op)
   }
   await op?.assertActive()
   op?.signal.throwIfAborted()
   if (disposed) throw fail('blocked')
   deliverySequence = batch.at(-1)!.sequence
   queue.splice(queue.indexOf(raw), 1)
   queueBytes -= Number(raw.__bytes)
   pending = batch
   return batch
  },
  async receiveSession(session) {
   if (receiveContext) throw fail('conflict')
   receiveContext = session
   fatal = undefined
   reconnectAt = 0
   try {
    if (!botId) await this.identify(session)
    let after: number | null = null
    while (!session.signal.aborted) {
     const batch: Batch = await self.receive(after, session)
     for (const row of batch) {
      if (row.event) {
       await session.accept({ kind: 'event', event: row.event })
       // The core owns the real reply. Complete only the private native receipt,
       // after acceptance, without exposing task data to an unauthorized caller.
       const receipt = commandReceipts.get(row.event.id)
       if (receipt) {
        commandReceipts.delete(row.event.id)
        await session.assertActive()
        session.signal.throwIfAborted()
        await finishCommand(receipt, session)
       }
      }
      after = row.sequence
     }
     await session.health({ state: ws ? 'polling' : 'backoff' })
    }
   } finally {
    receiveContext = undefined
    clearTimeout(heartbeat)
    ws?.terminate()
    ws = undefined
    reconnectAt = 0
    await commandsPending
    if (session.signal.aborted) {
     queue.length = 0
     queueBytes = 0
     pending = undefined
    }
   }
  },
  async dispose() {
   disposed = true
   queue.length = 0
   queueBytes = 0
   pending = undefined
   commandReceipts.clear()
   buttonReceipts.clear()
   lifecycle.abort()
   wake?.()
   clearTimeout(heartbeat)
   clearTimeout(dropTimer)
   reportDrops(false)
   ws?.terminate()
   ws = undefined
   request.close?.()
  },
 }
 return self
}
/** The published surface: `receiveSession` alone; the batch pull stays internal. */
export function createDiscordAdapter(...args: Parameters<typeof createDiscordReceiver>): ExtensionChatAdapter {
 const { receive: _pull, ...adapter } = createDiscordReceiver(...args)
 return adapter
}
