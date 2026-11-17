import { ExtensionChatError, type ChatBotServices, type ChatMessage, type ChatReceipt, type ChatEvent, type ExtensionChatAdapter, type ExtensionChatOperationContext } from '@open-mercato/cezar-extension-sdk/chat'
import { request as undiciRequest, Agent } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { pinPublicAddress, pinnedConnect, readCapped, type Address, type Lookup } from './pinned-request.js'
import { agentPool, remember, retryAfterMs, type AgentLease } from './adapter-support.js'

type Json = Record<string, unknown>
type Credentials = { appToken: string; botToken: string }
type ChatButtonRow = NonNullable<ChatMessage['buttons']>[number]
type ChatButton = ChatButtonRow[number]
const id = (v: unknown) => typeof v === 'string' && /^[A-Z0-9]+$/.test(v) ? v : undefined
const humanId = (v: unknown) => typeof v === 'string' && /^[UW][A-Z0-9]+$/.test(v) ? v : undefined
const channelId = (v: unknown) => typeof v === 'string' && /^[CDG][A-Z0-9]+$/.test(v) ? v : undefined
const ts = (v: unknown) => typeof v === 'string' && /^\d{10,16}\.\d{6}$/.test(v) ? v : undefined
const obj = (v: unknown): Json | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined
const text = (v: unknown, max = 65536) => typeof v === 'string' && v.length <= max ? v : undefined
const fail = (kind: 'auth'|'conflict'|'rate_limited'|'gone'|'transient'|'blocked', retryAfterMs?: number) => new ExtensionChatError({ kind, ...(retryAfterMs ? { retryAfterMs } : {}) })
const AUTH_ERRORS = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'], GONE_ERRORS = ['channel_not_found', 'not_in_channel', 'is_archived'], TRANSIENT_ERRORS = ['internal_error', 'service_unavailable', 'request_timeout', 'fatal_error']
function slackFailure(code: string) {
 return fail(
  AUTH_ERRORS.includes(code)
   ? 'auth'
   : code === 'too_many_connections'
     ? 'conflict'
     : code === 'ratelimited'
       ? 'rate_limited'
       : GONE_ERRORS.includes(code)
         ? 'gone'
         : TRANSIENT_ERRORS.includes(code)
           ? 'transient'
           : 'blocked',
  code === 'ratelimited' ? 5000 : undefined,
 )
}
function assertCredentials(c: Credentials) { if (!/^xapp-[A-Za-z0-9-]{10,}$/.test(c.appToken) || !/^xoxb-[A-Za-z0-9-]{10,}$/.test(c.botToken)) throw fail('auth') }
export type SlackRequestOptions = { lookup?: Lookup; request?: typeof undiciRequest }
/** `close` ends its pooled connections; a later call dials again. */
export type SlackRequest = ((method: string, body: Json, operation?: ExtensionChatOperationContext) => Promise<unknown>) & { close?(): void }
export function slackRequest(credentials: Credentials, options: SlackRequestOptions = {}, services?: ChatBotServices): SlackRequest {
 if (!services?.credentials) assertCredentials(credentials)
 const pool = agentPool(Agent)
 return Object.assign(async (method: string, body: Json, operation?: ExtensionChatOperationContext): Promise<unknown> => {
  await operation?.assertActive()
  operation?.signal.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort()
  operation?.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, method === 'apps.connections.open' ? 15000 : 10000)
  let lease: AgentLease<Agent> | undefined
  try {
   const target = await pinPublicAddress('slack.com', options.lookup ?? (async h => dnsLookup(h, { all: true, verbatim: true })), controller.signal, method === 'apps.connections.open' ? 15000 : 10000, fail); lease = pool.lease(target); const dispatcher = lease.agent
   await operation?.assertActive(); const form = new URLSearchParams(); for (const [key, value] of Object.entries(body)) if (value !== undefined) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
   const access = services?.credentials && operation ? await services.credentials.accessToken(method === 'apps.connections.open' ? 'app' : 'bot', operation) : method === 'apps.connections.open' ? credentials.appToken : credentials.botToken
   await operation?.assertActive()
   const response = await (options.request ?? undiciRequest)(`https://slack.com/api/${method}`, {
    dispatcher,
    method: 'POST',
    signal: controller.signal,
    headersTimeout: 10000,
    bodyTimeout: 10000,
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
   })
   const received = await readCapped(response.body, fail, controller.signal)
   // Slack answers its HTTP failures without a JSON body; classify them before parsing.
   if (response.statusCode === 429) throw fail('rate_limited', retryAfterMs(response.headers?.['retry-after'], 3600)); if (response.statusCode === 401) throw fail('auth'); if (response.statusCode >= 500) throw fail('transient'); if (response.statusCode >= 400) throw fail('blocked')
   const result = obj(JSON.parse(received.toString('utf8'))); if (result?.ok !== true) throw slackFailure(String(result?.error)); return result
  } catch (error) { if (error instanceof ExtensionChatError) throw error; throw fail(operation?.signal.aborted ? 'blocked' : 'transient') } finally { lease?.release(); clearTimeout(timer); operation?.signal.removeEventListener('abort', abort) }
 }, { close: () => pool.close() })
}

// Slack decodes these three entities even in plain-text messages. Escape once at
// the wire boundary so literal entities and explicit mention/link syntax survive.
function escapeText(value: string): string {
 return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
function textBlocks(value: string, formatted = false) {
 const chunks: string[] = []
 let chunk = ''
 // Sections render independently: keep graphemes intact and measure after escaping.
 const segments = formatted
  ? (value
     .match(/&(?:amp|lt|gt);|[^&]+|&/g)
     ?.flatMap(part =>
      /^&(?:amp|lt|gt);$/.test(part)
       ? [part]
       : [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part)].map(item => item.segment),
     ) ?? [])
  : [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment)
 for (const segment of segments) {
  const escaped = formatted ? segment : escapeText(segment)
  // Refuse before sending rather than fragmenting or dropping an oversized glyph.
  if (escaped.length > 3000) throw fail('blocked')
  if (chunk.length + escaped.length > 3000) { chunks.push(chunk); chunk = '' }
  chunk += escaped
 }
 if (chunk) chunks.push(chunk)
 return chunks.map(text => ({ type: 'section', text: formatted ? { type: 'mrkdwn', text, verbatim: true } : { type: 'plain_text', text, emoji: false } }))
}

function chat(team: string, bot: string, channel: string, kind: 'private'|'group') { return { id: `${kind}:${team}:${bot}:${channel}`, kind } as const }
function parseChat(value: string, team: string, bot: string) { const m = /^(private|group):([A-Z0-9]+):([A-Z0-9]+):([A-Z0-9]+)$/.exec(value); if (!m || m[2] !== team || m[3] !== bot) throw fail('blocked'); return { kind: m[1] as 'private'|'group', channel: m[4]! } }
function normalize(raw: Json, team: string, bot: string, inspect: (channel: string, op?: ExtensionChatOperationContext) => Promise<{ id: string; kind: 'private'|'group'; eligible: boolean }>, now: number, op?: ExtensionChatOperationContext, acceptAfter = now - 15 * 60_000) {
 const envelope = obj(raw); if (!envelope || typeof envelope.type !== 'string') return undefined
 const native = obj(envelope.payload)
 if (envelope.type === 'slash_commands') {
  if (
   native?.team_id !== team ||
   native.user_id === bot ||
   typeof native.user_id !== 'string' ||
   !/^[UW][A-Z0-9]+$/.test(native.user_id) ||
   native.command !== '/cezar' ||
   typeof native.channel_id !== 'string' ||
   !/^[CDG][A-Z0-9]+$/.test(native.channel_id) ||
   typeof native.text !== 'string' ||
   native.text.length > 65536 ||
   typeof native.trigger_id !== 'string' ||
   !native.trigger_id.length ||
   native.trigger_id.length > 256
  )
   return undefined
  return inspect(native.channel_id, op).then(ref => {
   if (!ref.eligible) return undefined
   const input = String(native.text).trim().replace(/^\//, '') || 'help'
   const command = /^(tasks|status|help)(?=\s|$)/.test(input) ? `/${input}` : '/help'
   const id = `slash:${createHash('sha256').update(`${team}:${native.trigger_id}`).digest('hex')}`
   return { kind: 'message' as const, id, messageId: id, chat: { id: ref.id, kind: ref.kind }, user: { id: native.user_id as string, label: native.user_id as string }, at: now, text: command, addressed: true }
  })
 }
 if (envelope.type === 'interactive') {
  const user = obj(native?.user), teamInfo = obj(native?.team), message = obj(native?.message), container = obj(native?.container)
  const actions = Array.isArray(native?.actions) ? native.actions as unknown[] : []
  const action = obj(actions[0])
  if (
   native?.type !== 'block_actions' ||
   teamInfo?.id !== team ||
   message?.user !== bot ||
   !humanId(user?.id) ||
   !channelId(container?.channel_id) ||
   typeof container?.message_ts !== 'string' ||
   !/^\d{10,16}\.\d{6}$/.test(container.message_ts) ||
   actions.length !== 1 ||
   !action ||
   typeof action.action_id !== 'string' ||
   !/^cezar_\d+$/.test(action.action_id) ||
   typeof action.value !== 'string' ||
   action.value.length > 128 ||
   typeof action.action_ts !== 'string' ||
   !/^\d{10,16}\.\d{6}$/.test(action.action_ts)
  )
   return undefined
  const actionAt = Number(action.action_ts) * 1000; if (!Number.isFinite(actionAt) || actionAt < acceptAfter || actionAt < now - 15 * 60_000 || actionAt > now + 60_000) return undefined
  return inspect(container!.channel_id as string, op).then(ref =>
   ref.eligible
    ? {
       kind: 'button' as const,
       id: `button:${container!.channel_id}:${user!.id}:${typeof action.action_ts === 'string' ? action.action_ts : envelope.envelope_id}`,
       chat: { id: ref.id, kind: ref.kind },
       user: { id: user!.id as string, label: user!.id as string },
       receipt: { chatId: ref.id, messageId: container!.message_ts as string },
       data: action.value as string,
      }
    : undefined,
  )
 }
 if (envelope.type !== 'events_api') return undefined
 const payload = native
 const event = obj(payload?.event)
 const auth = Array.isArray(payload?.authorizations) ? (payload!.authorizations as unknown[]) : []
 if (
  !payload ||
  !event ||
  payload.team_id !== team ||
  !auth.some(a => {
   const r = obj(a)
   return r?.is_bot === true && r.user_id === bot
  })
 )
  return undefined
 if (event.type === 'member_left_channel' && event.user === bot && channelId(event.channel)) {
  if (
   typeof payload.event_time !== 'number' ||
   !Number.isFinite(payload.event_time) ||
   payload.event_time * 1000 < acceptAfter ||
   payload.event_time * 1000 < now - 15 * 60_000 ||
   payload.event_time * 1000 > now + 60_000
  )
   return undefined
  return {
   kind: 'membership' as const,
   id: typeof payload.event_id === 'string' ? payload.event_id : `member:${event.channel}:${payload.event_time}`,
   chat: { id: `group:${team}:${bot}:${event.channel}`, kind: 'group' as const },
   reason: 'removed' as const,
  }
 }
 if (event.type !== 'message' && event.type !== 'app_mention') return undefined
 const channel = channelId(event.channel),
  user = humanId(event.user),
  stamp = ts(event.ts)
 if (!channel || !user || !stamp || event.bot_id || event.user === bot || event.subtype) return undefined
 const when = Math.floor(Number(stamp) * 1000)
 if (when < acceptAfter || when < now - 15 * 60_000 || when > now + 60_000) return undefined
 // A group drops unaddressed, uncorrelated text, so only a declared non-DM skips the lookup.
 const threaded = event.thread_ts !== undefined && event.thread_ts !== stamp
 if (['channel', 'group', 'mpim'].includes(String(event.channel_type ?? '')) && !channel.startsWith('D') && !String(event.text ?? '').includes(`<@${bot}>`) && !threaded) return undefined
 return inspect(channel, op).then(ref => {
  if (!ref.eligible) return undefined
  const mention = `<@${bot}>`
  const addressed = ref.kind === 'private' || String(event.text ?? '').includes(mention)
  const body = text(event.text)
  if (body === undefined || (ref.kind === 'group' && !addressed && event.thread_ts === undefined)) return undefined
  const clean = body
   .replaceAll(mention, '')
   .trim()
   .replaceAll('&lt;', '<')
   .replaceAll('&gt;', '>')
   .replaceAll('&amp;', '&')
   .replace(
    /^cezar\s+(start|task|tasks|status|reply|cancel|continue|help)(?=\s|$)/i,
    (_match, command: string) => `/${command.toLowerCase()}`,
   )
  const thread = event.thread_ts !== stamp ? ts(event.thread_ts) : undefined
  return {
   kind: 'message' as const,
   id: `msg:${channel}:${stamp}`,
   chat: { id: ref.id, kind: ref.kind },
   user: { id: user, label: user },
   at: when,
   text: clean,
   addressed,
   messageId: stamp,
   ...(thread ? { replyTo: { chatId: ref.id, messageId: thread } } : {}),
  }
 })
}

type Inspected = { id: string; kind: 'private'|'group'; eligible: boolean; membership: boolean | undefined; user: string | undefined }
const CACHE_TTL_MS = 5 * 60_000, CACHE_SIZE = 500, MAX_QUEUE = 100, RECONNECT_MS = 1000
// A head that cannot resolve would hold back every later event and keep the socket shut.
const HEAD_MAX_AGE_MS = 15 * 60_000, HEAD_ATTEMPTS = 3
type Queued = { row: Json; at: number; tries: number }
const LEAVING = ['member_left_channel', 'channel_left', 'group_left', 'channel_archive', 'group_archive', 'channel_deleted', 'group_deleted']
// One platform cursor step; a row without an event durably skips a platform no-op.
type Batch = { sequence: number; event?: ChatEvent }[]
type Receiver = ExtensionChatAdapter & { receive(after: number | null, operation: ExtensionChatOperationContext): Promise<Batch> }
/** The session loop's batch pull; only tests may reach it. */
export function createSlackReceiver(
 credentials: Record<string, string>,
 request: SlackRequest | undefined = undefined,
 options: {
  lookup?: (hostname: string) => Promise<Address[]>
  socket?: (
   url: string,
   lookup: (hostname: string, options: object, callback: (...args: unknown[]) => void) => void,
  ) => WebSocket
  report?: (message: string) => void
 } = {},
 services?: ChatBotServices,
): Receiver {
 const c = credentials as Credentials
 if (!services?.credentials) assertCredentials(c)
 request ??= slackRequest(c, {}, services)
 let team = '',
  bot = '',
  username = ''
 let socket: WebSocket | undefined
 let socketWait: Promise<void> | undefined
 const queue: Queued[] = []
 let wake: (() => void) | undefined
 let sequence = 0
 let disposed = false
 const lifecycle = new AbortController()
 let fatal: ExtensionChatError | undefined,
  reconnectAt = 0,
  infoLimitedUntil = 0,
  oldestAllowed: number | undefined
 // The head being handed over. It leaves the queue only once accepted or dropped by policy: Slack will not resend it.
 let taken: Queued | undefined
 let dropped = 0
 const commit = () => {
  if (taken) queue.shift()
  taken = undefined
 }
 const channels = new Map<string, { value: Inspected; until: number }>(),
  texts = new Map<string, { text: string; formatted: boolean }>()
 const call = async (method: string, body: Json, op?: ExtensionChatOperationContext) => {
  try {
   return await request!(method, body, op)
  } catch (error) {
   if (error instanceof ExtensionChatError && error.failure.kind === 'gone' && typeof body.channel === 'string')
    channels.delete(body.channel)
   throw error
  }
 }
 // Inbound events may reuse an eligible lookup; authorization paths always ask Slack.
 const inspect = async (channel: string, op?: ExtensionChatOperationContext, cached = false): Promise<Inspected> => {
  const hit = channels.get(channel)
  if (cached && hit && hit.until > Date.now()) return hit.value
  if (Date.now() < infoLimitedUntil) throw fail('rate_limited', infoLimitedUntil - Date.now())
  let response: unknown
  try {
   response = await call('conversations.info', { channel }, op)
  } catch (error) {
   if (error instanceof ExtensionChatError && error.failure.kind === 'rate_limited')
    infoLimitedUntil = Date.now() + (error.failure.retryAfterMs ?? 5000)
   throw error
  }
  const row = obj(obj(response)?.channel)
  if (!row || row.id !== channel || typeof row.is_im !== 'boolean') throw fail('blocked')
  const kind = row.is_im && row.is_mpim !== true ? ('private' as const) : ('group' as const)
  const membership =
   row.is_archived === true
    ? false
    : kind === 'private'
      ? true
      : typeof row.is_member === 'boolean'
        ? row.is_member
        : undefined
  const value: Inspected = {
   id: chat(team, bot, channel, kind).id,
   kind,
   eligible: membership === true,
   membership,
   user: id(row.user),
  }
  if (value.eligible) remember(channels, channel, { value, until: Date.now() + CACHE_TTL_MS }, CACHE_SIZE)
  else channels.delete(channel)
  return value
 }
 const stop = (reason: ExtensionChatError) => {
  fatal = reason
  socket?.terminate()
  wake?.()
  wake = undefined
 }
 const onFrame = (connection: WebSocket, data: unknown) => {
  // A hung-up socket can still flush buffered frames; left un-ACKed, Slack redelivers them.
  if (connection !== socket || connection.readyState !== WebSocket.OPEN) return
  lastFrame = Date.now()
  let row: Json | undefined
  try {
   row = obj(JSON.parse(String(data)))
  } catch {
   return
  }
  if (!row) return
  if (row.type === 'disconnect') {
   if (row.reason === 'link_disabled') stop(fail('blocked'))
   else connection.terminate()
   return
  }
  const envelopeId = text(row.envelope_id, 128)
  if (!envelopeId || !envelopeId.length || typeof row.type !== 'string') return
  // Over capacity, leave it un-ACKed: Slack redelivers on the next socket.
  if (queue.length >= MAX_QUEUE) {
   connection.terminate()
   return
  }
  // ACK at arrival, independent of API and core latency, or Slack retries after three seconds.
  try {
   connection.send(JSON.stringify({ envelope_id: envelopeId }))
  } catch {
   connection.terminate()
   return
  }
  const event = obj(obj(row.payload)?.event)
  if (typeof event?.channel === 'string' && LEAVING.includes(String(event.type))) channels.delete(event.channel)
  queue.push({ row, at: Date.now(), tries: 0 })
  wake?.()
  wake = undefined
 }
 let lastFrame = 0
 const open = async (op?: ExtensionChatOperationContext) => {
  const opened = obj(await call('apps.connections.open', {}, op))
  const raw = text(opened?.url)
  let parsed: URL
  try {
   parsed = new URL(raw ?? '')
  } catch {
   throw fail('blocked')
  }
  if (
   parsed.protocol !== 'wss:' ||
   (parsed.hostname !== 'slack.com' && !parsed.hostname.endsWith('.slack.com')) ||
   parsed.username ||
   parsed.password ||
   (parsed.port && parsed.port !== '443')
  )
   throw fail('blocked')
  const signal = new AbortController()
  const abort = () => signal.abort()
  lifecycle.signal.addEventListener('abort', abort, { once: true })
  op?.signal.addEventListener('abort', abort, { once: true })
  try {
   const target = await pinPublicAddress(
    parsed.hostname,
    options.lookup ?? (async h => dnsLookup(h, { all: true, verbatim: true })),
    signal.signal,
    10000,
    fail,
   )
   if (signal.signal.aborted) throw fail('blocked')
   const { lookup } = pinnedConnect(target)
   const connection = (socket = options.socket
    ? options.socket(parsed.toString(), lookup)
    : new WebSocket(parsed, {
       followRedirects: false,
       maxPayload: 1024 * 1024,
       handshakeTimeout: 15000,
       lookup: lookup as never,
      }))
   lastFrame = Date.now()
   const watchdog = setInterval(() => {
    if (Date.now() - lastFrame > 90_000) connection.terminate()
    else if (connection.readyState === WebSocket.OPEN) connection.ping?.()
   }, 30_000)
   watchdog.unref?.()
   connection.on('pong', () => {
    lastFrame = Date.now()
   })
   connection.on('message', data => onFrame(connection, data))
   socketWait = new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
     if (settled) return
     settled = true
     error ? reject(error) : resolve()
    }
    connection.once('open', () => finish())
    connection.on('error', () => finish(fail('transient')))
    connection.once('close', () => {
     clearInterval(watchdog)
     finish(fail('transient'))
     if (socket === connection) {
      socket = undefined
      socketWait = undefined
      reconnectAt = Date.now() + RECONNECT_MS
     }
     wake?.()
     wake = undefined
    })
   })
   try {
    await socketWait
   } catch (error) {
    connection.terminate()
    if (socket === connection) socket = undefined
    throw signal.signal.aborted ? fail('blocked') : error
   }
  } finally {
   lifecycle.signal.removeEventListener('abort', abort)
   op?.signal.removeEventListener('abort', abort)
  }
 }
 const next = async (op?: ExtensionChatOperationContext): Promise<Queued | undefined> => {
  commit()
  const deadline = Date.now() + 24000
  for (;;) {
   await op?.assertActive()
   op?.signal.throwIfAborted()
   if (disposed) throw fail('blocked')
   if (queue.length) return (taken = queue[0])
   if (fatal) throw fatal
   const remaining = deadline - Date.now()
   if (remaining <= 0) return undefined
   if (!socket && Date.now() >= reconnectAt) {
    await open(op)
    continue
   }
   await new Promise<void>((resolve, reject) => {
    let done = false
    const finish = (error?: unknown) => {
     if (done) return
     done = true
     clearTimeout(timer)
     op?.signal.removeEventListener('abort', onAbort)
     if (wake === onWake) wake = undefined
     error ? reject(error) : resolve()
    }
    const onAbort = () => finish(fail('blocked'))
    const onWake = () => finish()
    const timer = setTimeout(finish, Math.min(socket ? remaining : Math.max(reconnectAt - Date.now(), 1), remaining))
    wake = onWake
    op?.signal.addEventListener('abort', onAbort, { once: true })
   })
  }
 }
 const self: Receiver = {
  async identify(op) {
   const result = obj(await call('auth.test', {}, op))
   const t = id(result?.team_id),
    b = id(result?.user_id)
   if (!t || !t.startsWith('T') || !b || !b.startsWith('U')) throw fail('blocked')
   team = t
   bot = b
   username = `${t}:${b}`
   return { id: username, username, discoveryUrl: 'https://api.slack.com/apps' }
  },
  async inspect(chatId, op) {
   if (!team || !bot) await this.identify(op)
   const parsed = parseChat(chatId, team, bot)
   const value = await inspect(parsed.channel, op)
   if (value.id !== chatId) throw fail('blocked')
   return value
  },
  async send(chatId, message: ChatMessage, op) {
   if (!team || !bot) await this.identify(op)
   const formatted = message.textFormat === 'slack-mrkdwn'
   if ((message.textFormat && message.textFormat !== 'plain' && !formatted) || (formatted && /[<>]/.test(message.text)))
    throw fail('blocked')
   const parsed = parseChat(chatId, team, bot)
   if (!message.text || message.text.length > 4000 || (message.buttons?.flat().length ?? 0) > 25) throw fail('blocked')
   const blocks = message.buttons?.length
    ? message.buttons.map((row: ChatButtonRow, ri: number) => ({
       type: 'actions',
       elements: row.map((button: ChatButton, i: number) => ({
        type: 'button',
        action_id: `cezar_${ri * 25 + i}`,
        text: { type: 'plain_text', text: button.text.slice(0, 75) },
        value: button.data,
       })),
      }))
    : undefined
   const result = obj(
    await call(
     'chat.postMessage',
     {
      channel: parsed.channel,
      text: formatted ? message.text : escapeText(message.text),
      mrkdwn: formatted,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
      ...(blocks ? { blocks: [...textBlocks(message.text, formatted), ...blocks] } : {}),
      ...(message.replyTo
       ? {
          thread_ts:
           parseChat(message.replyTo.chatId, team, bot).channel === parsed.channel && ts(message.replyTo.messageId)
            ? message.replyTo.messageId
            : (() => {
               throw fail('blocked')
              })(),
         }
       : {}),
     },
     op,
    ),
   )
   const channel = text(result?.channel),
    messageId = ts(result?.ts)
   if (channel !== parsed.channel || !messageId) throw fail('blocked')
   if (blocks)
    remember(
     texts,
     `${parsed.channel}:${messageId}`,
     { text: formatted ? message.text : escapeText(message.text), formatted: true },
     CACHE_SIZE,
    )
   return { chatId, messageId }
  },
  // chat.update needs text: keep the original sections, and never overwrite a message whose text is unknown.
  async clearButtons(receipt: ChatReceipt, op) {
   if (!team || !bot) await this.identify(op)
   const parsed = parseChat(receipt.chatId, team, bot)
   if (!ts(receipt.messageId)) throw fail('blocked')
   const key = `${parsed.channel}:${receipt.messageId}`
   const own = (result: unknown) => {
    const rows = obj(result)?.messages
    if (!Array.isArray(rows)) throw fail('blocked')
    const row = rows.map(obj).find(item => item?.ts === receipt.messageId && item.user === bot)
    return typeof row?.text === 'string' ? row.text : undefined
   }
   let current = texts.get(key)?.text
   if (current === undefined)
    current = own(
     await call(
      'conversations.history',
      { channel: parsed.channel, latest: receipt.messageId, oldest: receipt.messageId, inclusive: true, limit: 1 },
      op,
     ),
    )
   // conversations.history omits thread replies; answer buttons are often sent into a thread.
   if (current === undefined)
    current = own(
     await call(
      'conversations.replies',
      { channel: parsed.channel, ts: receipt.messageId, latest: receipt.messageId, inclusive: true, limit: 1 },
      op,
     ),
    )
   if (!current || current.length > 40000) return
   const result = await call(
    'chat.update',
    { channel: parsed.channel, ts: receipt.messageId, text: current, blocks: textBlocks(current, true) },
    op,
   )
   if (obj(result)?.channel && obj(result)?.channel !== parsed.channel) throw fail('blocked')
   texts.delete(key)
  },
  async acknowledge() {},
  async isMember(chatId, userId, op) {
   try {
    if (!team || !bot) await this.identify(op)
    const parsed = parseChat(chatId, team, bot),
     self = userId === `${team}:${bot}`
    if (self) userId = bot
    if (!/^[A-Z0-9]+$/.test(userId)) return false
    const info = await inspect(parsed.channel, op)
    if (info.id !== chatId || info.membership === false) return false
    if (info.membership === undefined) return undefined
    if (parsed.kind === 'private') return self ? true : info.user === undefined ? undefined : info.user === userId
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
     const result = obj(
      await call('conversations.members', { channel: parsed.channel, limit: 200, ...(cursor ? { cursor } : {}) }, op),
     )
     if (!Array.isArray(result?.members) || !result.members.every(member => typeof member === 'string'))
      return undefined
     if (result.members.includes(userId)) return true
     const meta = obj(result.response_metadata)
     if (
      result.response_metadata !== undefined &&
      (!meta || (meta.next_cursor !== undefined && typeof meta.next_cursor !== 'string'))
     )
      return undefined
     cursor = typeof meta?.next_cursor === 'string' ? meta.next_cursor : undefined
     if (!cursor) return false
    }
    return undefined
   } catch (error) {
    if (op?.signal.aborted) throw error
    return error instanceof ExtensionChatError && error.failure.kind === 'gone' ? false : undefined
   }
  },
  async receive(after, op): Promise<Batch> {
   if (disposed) throw fail('blocked')
   if (!team || !bot) await this.identify(op)
   if (after !== null && Number.isSafeInteger(after)) sequence = Math.max(sequence, after)
   oldestAllowed ??= Date.now() - 1000
   const head = await next(op)
   if (!head) return []
   if (Date.now() - head.at > HEAD_MAX_AGE_MS || head.tries++ >= HEAD_ATTEMPTS) {
    dropped++
    ;(options.report ?? console.error)(
     `Slack dropped an acknowledged event it could not resolve in time (${dropped} so far); Slack will not resend it.`,
    )
    return [{ sequence: ++sequence }]
   }
   let resolved: Awaited<ReturnType<typeof normalize>>
   try {
    resolved = await normalize(
     head.row,
     team,
     bot,
     (channel, operation) => inspect(channel, operation, true),
     Date.now(),
     op,
     oldestAllowed,
    )
   } catch (error) {
    // The envelope is already ACKed: a per-channel lookup failure (missing_scope)
    // drops this one event, never the bot. Only auth and a bounded transient retry end the session.
    await op?.assertActive()
    op?.signal.throwIfAborted()
    if (!(error instanceof ExtensionChatError) || ['auth', 'transient'].includes(error.failure.kind)) {
     taken = undefined
     throw error
    }
    if (!['gone', 'rate_limited'].includes(error.failure.kind)) {
     dropped++
     ;(options.report ?? console.error)(
      `Slack dropped an acknowledged event it is not allowed to resolve (${dropped} so far); check the app's conversation scopes.`,
     )
    }
    resolved = undefined
   }
   const n = ++sequence
   return [{ sequence: n, ...(resolved ? { event: resolved } : {}) }]
  },
  async receiveSession(session) {
   let renewAt = Date.now() + 24000
   fatal = undefined
   reconnectAt = 0
   // Synchronous, so no frame is ACKed once stop began, and a handshake cannot outlive it.
   const hangUp = () => socket?.terminate()
   session.signal.addEventListener('abort', hangUp, { once: true })
   try {
    while (!session.signal.aborted) {
     const batch = await self.receive(null, session)
     // The envelope is already ACKed. Hand it to core before unrelated maintenance.
     for (const row of batch)
      if (row.event) {
       await session.assertActive()
       session.signal.throwIfAborted()
       await session.accept({ kind: 'event', event: row.event })
      }
     commit()
     // receive wakes at least every 24 seconds, including on a silent socket. A failed
     // renewal ends the session, so ACKed events go first; the host keeps the refresh material.
     if (services?.credentials && Date.now() >= renewAt && !queue.length) {
      await session.assertActive()
      session.signal.throwIfAborted()
      await services.credentials.accessToken('app', session)
      await session.assertActive()
      session.signal.throwIfAborted()
      await services.credentials.accessToken('bot', session)
      renewAt = Date.now() + 24000
     }
     await session.health({ state: socket ? 'polling' : 'backoff' })
    }
   } finally {
    session.signal.removeEventListener('abort', hangUp)
    socket?.terminate()
    socket = undefined
    reconnectAt = 0
    taken = undefined
    // Only a stop forgets the queue: the host fences acceptance after abort, and a same-adapter
    // restart drains it. The ACKs cannot be taken back, so say what was lost.
    if (session.signal.aborted && queue.length) {
     ;(options.report ?? console.error)(
      `Slack dropped ${queue.length} acknowledged event(s) at session stop; Slack will not resend them.`,
     )
     queue.length = 0
    }
   }
  },
  async dispose() {
   disposed = true
   lifecycle.abort()
   wake?.()
   wake = undefined
   socket?.terminate()
   socket = undefined
   if (socketWait) await socketWait.catch(() => undefined)
   request!.close?.()
  },
 }
 return self
}
/** The published surface: `receiveSession` alone; the batch pull stays internal. */
export function createSlackAdapter(...args: Parameters<typeof createSlackReceiver>): ExtensionChatAdapter {
 const { receive: _pull, ...adapter } = createSlackReceiver(...args)
 return adapter
}
