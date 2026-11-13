import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { setImmediate as turn } from 'node:timers/promises'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { createDiscordReceiver, discordRequest } from '../dist/adapter.js'

const bot = '10000000000000001', user = '40000000000000004', guild = '20000000000000002', dm = '30000000000000003', room = '30000000000000005', other = '30000000000000007'
const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
const op = { signal: new AbortController().signal, assertActive: async () => {} }
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await turn() }
const human = { id: user, username: 'human' }
const clock = t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-11T00:00:00Z') })
let ids = 70000000000000000n
const message = (extra = {}) => ({ id: String(++ids), channel_id: dm, author: human, content: 'hi', timestamp: new Date().toISOString(), ...extra })
const mention = (extra = {}) => message({ channel_id: room, guild_id: guild, content: `<@${bot}> hi`, ...extra })
const button = (extra = {}) => ({ id: String(++ids), application_id: bot, type: 3, token: 'fixture-token', channel_id: dm, user: human, data: { custom_id: 'action', component_type: 2 }, message: { id: '50000000000000005', channel_id: dm, author: { id: bot, bot: true } }, ...extra })
const limited = retryAfterMs => new ExtensionChatError({ kind: 'rate_limited', retryAfterMs })
const failure = kind => new ExtensionChatError({ kind })
const channelOf = path => path.startsWith(`/channels/${dm}`) ? { id: dm, type: 1, recipients: [{ id: user }] } : path.startsWith(`/channels/${room}`) ? { id: room, type: 0, guild_id: guild } : path.startsWith(`/channels/${other}`) ? { id: other, type: 1, recipients: [{ id: user }] } : undefined

class Socket extends EventEmitter {
 sent = []; closed = false
 send(value) { this.sent.push(JSON.parse(value)) }
 terminate() { if (!this.closed) { this.closed = true; this.emit('close') } }
 close(code) { if (!this.closed) { this.closed = true; this.emit('close', code) } }
 frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))) }
}
function harness(t, { rest = async () => undefined, gateway = { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } }, ready = () => ({ user: { id: bot, username: 'bot', bot: true }, session_id: 'session', resume_gateway_url: 'wss://gateway-resume.discord.gg/' }), hello = 120000, autoAck = true, withholdReady = false } = {}) {
 const sockets = [], calls = [], accepted = [], states = [], reports = [], urls = []
 let seq = 1
 const adapter = createDiscordReceiver({ token: 'fixture' }, async (method, path, body, operation) => {
  calls.push({ method, path, body })
  const result = await rest(method, path, body, operation)
  if (result !== undefined) return result
  if (path === '/users/@me') return { id: bot, username: 'bot', bot: true }
  if (path === '/gateway/bot') return typeof gateway === 'function' ? gateway() : gateway
  return channelOf(path) ?? {}
 }, url => {
  urls.push(url); const socket = new Socket(); sockets.push(socket)
  const send = socket.send.bind(socket)
  socket.send = value => { send(value); const frame = JSON.parse(value); if (frame.op === 1 && autoAck) socket.frame({ op: 11 }); if (frame.op === 2 && !withholdReady) socket.frame({ op: 0, t: 'READY', s: seq = 1, d: ready() }); if (frame.op === 6) socket.frame({ op: 0, t: 'RESUMED', s: seq = frame.d.seq + 1, d: {} }) }
  queueMicrotask(() => socket.frame({ op: 10, d: { heartbeat_interval: hello } }))
  return socket
 }, lookup, async line => { reports.push(line) })
 const controller = new AbortController()
 const session = { signal: controller.signal, assertActive: async () => controller.signal.throwIfAborted(), accept: async delivery => { accepted.push(delivery.event); return { disposition: 'accepted', checkpoint: { epoch: 'x', nextSequence: null } } }, health: async value => { states.push(value.state) }, checkpoint: async () => ({ epoch: 'x', nextSequence: null }), openInteraction: async () => { throw Error('unused') } }
 let outcome
 const running = () => adapter.receiveSession(session).then(() => { outcome = 'resolved' }, error => { outcome = error })
 const start = () => { const done = running(); t.after(async () => { controller.abort(); await done; await adapter.dispose() }); return done }
 const dispatch = (type, data) => sockets.at(-1).frame({ op: 0, t: type, s: ++seq, d: data })
 const ids = () => accepted.map(event => event.id)
 return { adapter, session, controller, sockets, calls, accepted, states, reports, urls, start, dispatch, ids, outcome: () => outcome, lookups: id => calls.filter(call => call.path === `/channels/${id}`).length }
}

test('identify reports the bot id as the username the core keys on', async () => {
 const adapter = createDiscordReceiver({ token: 'x' }, async () => ({ id: bot, username: 'Cezar', bot: true }))
 assert.deepEqual(await adapter.identify(op), { id: bot, username: bot, discoveryUrl: 'https://discord.com/developers/applications' })
 for (const me of [{ id: bot, username: 'human' }, { id: 'not-a-snowflake', username: 'x', bot: true }]) await assert.rejects(createDiscordReceiver({ token: 'x' }, async () => me).identify(op), e => e.failure?.kind === 'auth')
})
test('outbound ids are validated before they reach a URL', async () => {
 const calls = [], adapter = createDiscordReceiver({ token: 'x' }, async (_m, path) => { calls.push(path); return channelOf(path) ?? { id: 'bad', channel_id: dm } })
 await assert.rejects(adapter.clearButtons({ chatId: `discord:dm:${dm}`, messageId: '../../x' }, op), e => e.failure?.kind === 'blocked')
 assert.equal(await adapter.isMember(`discord:guild:${guild}:${room}`, '../..', op), undefined)
 assert.deepEqual(calls, [])
 await assert.rejects(adapter.send(`discord:dm:${dm}`, { text: 'x' }, op), e => e.failure?.kind === 'blocked', 'a non-snowflake receipt')
 await assert.rejects(adapter.inspect('nonsense', op), e => e.failure?.kind === 'blocked')
})
test('acknowledge never patches the message that carried the button', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', button()); await settle()
 await h.adapter.acknowledge(h.accepted[0].id, 'Confirmed', op)
 assert.deepEqual(h.calls.filter(call => call.method === 'PATCH'), [])
})
test('acknowledge answers the tapper once with an ephemeral follow-up', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', button()); await settle()
 await h.adapter.acknowledge(h.accepted[0].id, 'This button is no longer available.', op)
 await h.adapter.acknowledge(h.accepted[0].id, 'again', op)
 await h.adapter.acknowledge('interaction:1', 'unknown', op)
 assert.deepEqual(h.calls.filter(call => call.path.startsWith('/webhooks/')), [{ method: 'POST', path: `/webhooks/${bot}/fixture-token`, body: { content: 'This button is no longer available.', flags: 64, allowed_mentions: { parse: [] } } }])
})
test('acknowledge stays silent once the interaction token expired', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', button()); await settle()
 t.mock.timers.tick(14 * 60000)
 await h.adapter.acknowledge(h.accepted[0].id, 'late', op)
 assert.equal(h.calls.some(call => call.path.startsWith('/webhooks/')), false)
})
test('stop during a stalled handshake returns without waiting out its timer', async t => {
 clock(t); const h = harness(t, { withholdReady: true }); const done = h.start(); await settle()
 h.controller.abort(); await done
 assert.equal(h.sockets[0].closed, true)
})

const reply = (statusCode, value, headers = {}) => ({ statusCode, headers, body: Readable.from(value === undefined ? [] : [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]) })
const rest = script => { const queue = [...script]; return discordRequest('fixture', { lookup, request: async () => { const next = queue.shift(); if (next instanceof Error) throw next; return next } }) }
const kindOf = kind => e => e.failure?.kind === kind
test('a 429 carries Discord\'s wait, falls back to the header, and holds the route', async () => {
 const request = rest([reply(429, { retry_after: 1.25 })])
 await assert.rejects(request('POST', `/channels/${dm}/messages`, {}, op), e => e.failure?.retryAfterMs === 1250)
 await assert.rejects(request('POST', `/channels/${dm}/messages`, {}, op), kindOf('rate_limited'))
 await assert.rejects(rest([reply(429, {}, { 'retry-after': '3' })])('GET', '/users/@me', undefined, op), e => e.failure?.retryAfterMs === 3000)
 await assert.rejects(rest([reply(429, {})])('GET', '/users/@me', undefined, op), e => e.failure?.retryAfterMs === 5000)
})
test('only reads are transient: an ambiguous write is never retried', async () => {
 await assert.rejects(rest([reply(500, {})])('POST', '/channels/1/messages', {}, op), kindOf('blocked'))
 await assert.rejects(rest([reply(500, {})])('GET', '/users/@me', undefined, op), kindOf('transient'))
 await assert.rejects(rest([new Error('token must not leak')])('POST', '/channels/1/messages', {}, op), e => e.failure?.kind === 'blocked' && !String(e).includes('token must'))
 await assert.rejects(rest([new Error('x')])('GET', '/users/@me', undefined, op), kindOf('transient'))
 await assert.rejects(rest([reply(200, '<html>')])('POST', '/channels/1/messages', {}, op), kindOf('blocked'))
 await assert.rejects(rest([reply(200, '<html>')])('GET', '/users/@me', undefined, op), kindOf('transient'))
 await assert.rejects(rest([reply(302, '')])('GET', '/users/@me', undefined, op), kindOf('transient'))
 await assert.rejects(rest([reply(302, '')])('POST', '/channels/1/messages', {}, op), kindOf('blocked'))
})
test('a missed deadline follows the same read/write split', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] })
 const hung = discordRequest('fixture', { lookup, request: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
 for (const [method, kind] of [['GET', 'transient'], ['POST', 'blocked']]) {
  const rejected = assert.rejects(hung(method, `/channels/${method === 'GET' ? 1 : 2}`, undefined, op), kindOf(kind))
  await settle(); t.mock.timers.tick(10_000); await rejected
 }
})
test('an exhausted bucket is scoped to its route and major parameter', async () => {
 const exhausted = { 'x-ratelimit-bucket': 'b1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '5' }
 const request = rest([reply(200, { id: '1' }, exhausted), reply(200, { id: '30' }), reply(200, { id: '2' })])
 await request('POST', '/channels/10/messages', {}, op)
 assert.deepEqual(await request('GET', '/channels/30', undefined, op), { id: '30' })
 assert.deepEqual(await request('POST', '/channels/11/messages', {}, op), { id: '2' })
 await assert.rejects(request('POST', '/channels/10/messages', {}, op), kindOf('rate_limited'))
})
test('only a global limit holds every route', async () => {
 const request = rest([reply(429, { retry_after: 2, global: true })])
 await assert.rejects(request('POST', '/channels/10/messages', {}, op), e => e.failure?.retryAfterMs === 2000)
 await assert.rejects(request('GET', '/channels/30', undefined, op), kindOf('rate_limited'))
})
test('a route cooldown recorded before the bucket hash was learned still applies', async () => {
 const request = rest([reply(429, { retry_after: 5 }), reply(200, {}, { 'x-ratelimit-bucket': 'b1', 'x-ratelimit-remaining': '1' })])
 await assert.rejects(request('GET', '/channels/30', undefined, op), kindOf('rate_limited'))
 await assert.rejects(request('GET', '/channels/30', undefined, op), kindOf('rate_limited'))
})
test('expired cooldowns are evicted before a live one', async t => {
 t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
 const headers = seconds => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': seconds })
 const request = rest([reply(200, {}, headers('60')), ...Array.from({ length: 512 }, () => reply(200, {}, headers('0.001')))])
 for (let id = 1; id <= 513; id++) { await request('POST', `/channels/${id}/messages`, {}, op); t.mock.timers.tick(2) }
 await assert.rejects(request('POST', '/channels/1/messages', {}, op), kindOf('rate_limited'))
})

test('a sharded bot is refused before dialing', async t => {
 const h = harness(t, { gateway: { url: 'wss://gateway.discord.gg/', shards: 2, session_start_limit: { remaining: 10 } } })
 await h.start(); assert.equal(h.outcome().failure?.kind, 'blocked'); assert.equal(h.sockets.length, 0)
})
for (const [code, kind] of [[4004, 'auth'], [4014, 'blocked'], [4013, 'blocked'], [4011, 'blocked']]) test(`close ${code} stops the session as ${kind}, without reconnecting`, async t => {
 clock(t); const h = harness(t); const done = h.start(); await settle()
 h.sockets[0].close(code); await done
 assert.equal(h.outcome().failure?.kind, kind); assert.equal(h.sockets.length, 1)
})
for (const code of [4007, 4009]) test(`close ${code} forgets the session and identifies again`, async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.sockets[0].close(code); await settle(); t.mock.timers.tick(5000); await settle()
 assert.equal(h.sockets[1].sent.some(frame => frame.op === 2), true); assert.equal(h.sockets[1].sent.some(frame => frame.op === 6), false)
})
test('a dropped socket waits five seconds, then resumes on the resume URL', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', message()); await settle()
 h.sockets[0].terminate(); await settle()
 t.mock.timers.tick(4900); await settle(); assert.equal(h.sockets.length, 1)
 t.mock.timers.tick(100); await settle(); assert.equal(h.sockets.length, 2)
 assert.match(h.urls[1], /gateway-resume\.discord\.gg/)
 assert.deepEqual(h.sockets[1].sent.find(frame => frame.op === 6).d, { token: 'fixture', session_id: 'session', seq: 2 })
})
test('opcode 7 reconnects and resumes immediately', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', message()); await settle()
 h.sockets[0].frame({ op: 7, d: null }); await settle(12)
 assert.equal(h.sockets.length, 2, 'Discord asks for an immediate reconnect, not a backoff')
 assert.match(h.urls[1], /gateway-resume\.discord\.gg/)
 assert.deepEqual(h.sockets[1].sent.find(frame => frame.op === 6).d, { token: 'fixture', session_id: 'session', seq: 2 })
})
test('health returns to polling once a dropped socket resumes, without waiting for traffic', async t => {
 clock(t); const h = harness(t, { rest: limitOnce(1000) }); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', mention()); await settle()
 h.sockets[0].terminate(); await settle()
 t.mock.timers.tick(1000); await settle(12)
 assert.equal(h.accepted.length, 1); assert.equal(h.states.at(-1), 'backoff', 'delivered between sockets')
 t.mock.timers.tick(4000); await settle(12)
 assert.equal(h.sockets.length, 2); assert.equal(h.states.at(-1), 'polling')
})
test('a missing heartbeat ACK reconnects', async t => {
 clock(t); const h = harness(t, { hello: 100, autoAck: false }); h.start(); await settle()
 t.mock.timers.tick(100); await settle()
 assert.equal(h.sockets[0].sent.find(frame => frame.op === 1)?.d, 1)
 t.mock.timers.tick(100); await settle(); assert.equal(h.sockets[0].closed, true)
})
test('a heartbeat before any dispatch carries null', async t => {
 clock(t); const h = harness(t, { withholdReady: true }); h.start(); await settle()
 h.sockets[0].frame({ op: 1 })
 assert.equal(h.sockets[0].sent.find(frame => frame.op === 1)?.d, null)
})
test('a replayed sequence is suppressed', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 const once = message(); h.sockets[0].frame({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: once }); h.sockets[0].frame({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: once }); await settle()
 assert.equal(h.accepted.length, 1)
})
test('READY for another bot is an auth failure, and a hostile resume URL cannot crash the worker', async t => {
 clock(t); let h = harness(t, { ready: () => ({ user: { id: '10000000000000099', bot: true }, session_id: 's' }) })
 await h.start(); assert.equal(h.outcome().failure?.kind, 'auth')
 h = harness(t, { ready: () => ({ user: { id: bot, bot: true }, session_id: 's', resume_gateway_url: 'wss://evil.example/' }) })
 await h.start(); assert.equal(h.outcome().failure?.kind, 'blocked')
})
test('a malformed frame after the handshake stops the session', async t => {
 clock(t); const h = harness(t); const done = h.start(); await settle()
 h.sockets[0].emit('message', Buffer.from('not json')); await done
 assert.equal(h.outcome().failure?.kind, 'blocked')
})
test('a spent identify budget refreshes at reset_after instead of blocking', async t => {
 clock(t); const limits = [{ remaining: 1, reset_after: 50_000 }, { remaining: 5, reset_after: 50_000 }]
 const h = harness(t, { gateway: () => ({ url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: limits.length > 1 ? limits.shift() : limits[0] }) })
 h.start(); await settle()
 h.sockets[0].frame({ op: 9, d: false }); await settle()
 t.mock.timers.tick(49_000); await settle()
 assert.equal(h.sockets.length, 1); assert.equal(h.calls.filter(c => c.path === '/gateway/bot').length, 1); assert.equal(h.states.at(-1), 'backoff')
 t.mock.timers.tick(1000); await settle(12)
 assert.equal(h.sockets.length, 2); assert.equal(h.calls.filter(c => c.path === '/gateway/bot').length, 2)
 assert.equal(h.sockets[1].sent.some(frame => frame.op === 2), true)
})
test('Discord omitting reset_after waits a minute', async t => {
 clock(t); const h = harness(t, { gateway: { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1 } } })
 h.start(); await settle()
 h.sockets[0].frame({ op: 9, d: false }); await settle()
 t.mock.timers.tick(59_000); await settle(); assert.equal(h.sockets.length, 1)
 t.mock.timers.tick(1000); await settle(12); assert.equal(h.sockets.length, 2)
})
test('commands register once on READY, never gating receive, and retry after a failure', async t => {
 clock(t); let fail = true
 const h = harness(t, { rest: async (method) => { if (method === 'PUT' && fail) throw limited(1000) } })
 h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', message()); await settle()
 assert.equal(h.accepted.length, 1, 'the rate-limited PUT did not stop the session')
 assert.deepEqual(h.calls.find(c => c.method === 'PUT').body[0].options[0].autocomplete, true)
 fail = false
 h.sockets[0].frame({ op: 9, d: false }); await settle(); t.mock.timers.tick(5000); await settle(12)
 assert.equal(h.calls.filter(c => c.method === 'PUT').length, 2)
 h.sockets[1].frame({ op: 9, d: false }); await settle(); t.mock.timers.tick(5000); await settle(12)
 assert.equal(h.calls.filter(c => c.method === 'PUT').length, 2, 'not re-registered once it succeeded')
})

test('guild chatter costs no lookup, identity is cached, and a channel event invalidates it', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', message({ channel_id: room, guild_id: guild, content: 'chatter' })); await settle()
 assert.equal(h.lookups(room), 0)
 h.dispatch('MESSAGE_CREATE', mention()); h.dispatch('MESSAGE_CREATE', mention()); await settle()
 assert.equal(h.accepted.length, 2); assert.equal(h.lookups(room), 1)
 h.dispatch('CHANNEL_UPDATE', { id: room, type: 0, guild_id: guild }); h.dispatch('MESSAGE_CREATE', mention()); await settle()
 assert.equal(h.accepted.length, 3); assert.equal(h.lookups(room), 2)
})
test('an unsupported or mismatched channel loses only its input', async t => {
 clock(t); const thread = { id: room, type: 11, guild_id: guild }
 let answer = thread
 const h = harness(t, { rest: async (_m, path) => path === `/channels/${room}` ? answer : undefined }); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', mention()); await settle()
 answer = { id: other, type: 0, guild_id: guild }
 h.dispatch('MESSAGE_CREATE', mention()); h.dispatch('MESSAGE_CREATE', message()); await settle()
 assert.deepEqual(h.accepted.map(e => e.chat.id), [`discord:dm:${dm}`]); assert.equal(h.outcome(), undefined)
})
test('records the host schema would refuse are ignored instead of stopping the session', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', message({ timestamp: 'yesterday' }))
 h.dispatch('MESSAGE_CREATE', message({ author: { id: user, username: 'x'.repeat(129) } }))
 h.dispatch('INTERACTION_CREATE', button({ token: '../../evil' }))
 h.dispatch('INTERACTION_CREATE', button({ data: { custom_id: 'sel', component_type: 3 } }))
 h.dispatch('MESSAGE_CREATE', message()); await settle()
 assert.equal(h.accepted.length, 1); assert.equal(h.calls.some(c => c.path.includes('/callback')), false); assert.equal(h.outcome(), undefined)
})
for (const kind of ['blocked', 'gone', 'transient']) test(`a ${kind} lookup loses only that input and the next message flows`, async t => {
 clock(t); const h = harness(t, { rest: async (_m, path) => { if (path === `/channels/${room}`) throw failure(kind) } }); h.start(); await settle()
 const lost = mention(); h.dispatch('MESSAGE_CREATE', lost); h.dispatch('MESSAGE_CREATE', message()); await settle()
 assert.deepEqual(h.accepted.map(e => e.chat.id), [`discord:dm:${dm}`]); assert.equal(h.sockets.length, 1); assert.equal(h.outcome(), undefined)
 assert.equal(h.reports.length, 1); assert.match(h.reports[0], new RegExp(`${lost.id}.*${kind}.*not processed`))
})
test('a 401 during a lookup stops the session', async t => {
 clock(t); const h = harness(t, { rest: async (_m, path) => { if (path === `/channels/${room}`) throw failure('auth') } }); const done = h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', mention()); await done
 assert.equal(h.outcome().failure?.kind, 'auth'); assert.deepEqual(h.accepted, [])
})

const limitOnce = (ms, id = room) => { let first = true; return async (_m, path) => { if (path === `/channels/${id}` && first) { first = false; throw limited(ms) } } }
test('a rate-limited lookup is held while other chats keep flowing, then admitted', async t => {
 clock(t); const h = harness(t, { rest: limitOnce(5500) }); h.start(); await settle()
 const held = mention(), next = message(); h.dispatch('MESSAGE_CREATE', held); h.dispatch('MESSAGE_CREATE', next); await settle()
 assert.deepEqual(h.ids(), [`message:${next.id}`])
 t.mock.timers.tick(5400); await settle(); assert.deepEqual(h.ids(), [`message:${next.id}`])
 t.mock.timers.tick(100); await settle(); assert.deepEqual(h.ids(), [`message:${next.id}`, `message:${held.id}`])
 assert.equal(h.sockets.length, 1); assert.equal(h.states.includes('backoff'), false)
})
test('later input in a held chat stays behind it', async t => {
 clock(t); const h = harness(t, { rest: limitOnce(1000) }); h.start(); await settle()
 const first = mention(), second = mention(), elsewhere = message(); h.dispatch('MESSAGE_CREATE', first); h.dispatch('MESSAGE_CREATE', second); h.dispatch('MESSAGE_CREATE', elsewhere); await settle()
 assert.deepEqual(h.ids(), [`message:${elsewhere.id}`])
 t.mock.timers.tick(1000); await settle(); assert.deepEqual(h.ids(), [`message:${elsewhere.id}`, `message:${first.id}`, `message:${second.id}`])
})
test('input limited past the budget is dropped once, reported without identifiers, and the session stays up', async t => {
 clock(t); const h = harness(t, { rest: async (_m, path) => { if (path === `/channels/${room}`) throw limited(120_000) } }); h.start(); await settle()
 const lost = mention(), next = message(); h.dispatch('MESSAGE_CREATE', lost); h.dispatch('MESSAGE_CREATE', next); await settle()
 assert.deepEqual(h.ids(), [`message:${next.id}`])
 assert.deepEqual(h.reports, ['Discord dropped held chat input (1 guild over the 60 s hold budget); Gateway resume cannot replay it.'])
 assert.equal(h.sockets.length, 1); assert.equal(h.outcome(), undefined)
})
test('a channel removal behind a full hold cap is still emitted, after its chat, and the drop is reported', async t => {
 clock(t); const h = harness(t, { rest: limitOnce(1500) }); h.start(); await settle()
 h.dispatch('GUILD_CREATE', { id: guild, channels: [{ id: room, type: 0 }] }); await settle()
 const head = mention(); h.dispatch('MESSAGE_CREATE', head); await settle()
 for (let i = 0; i < 100; i++) h.dispatch('MESSAGE_CREATE', mention())
 await settle()
 h.dispatch('CHANNEL_DELETE', { id: room, guild_id: guild, type: 0 }); const flowing = message(); h.dispatch('MESSAGE_CREATE', flowing); await settle()
 assert.deepEqual(h.ids(), [`message:${flowing.id}`])
 t.mock.timers.tick(1500); await settle(300)
 assert.equal(h.accepted.at(-1).kind, 'membership'); assert.equal(h.accepted.at(-1).chat.id, `discord:guild:${guild}:${room}`)
 assert.equal(h.accepted.filter(e => e.kind === 'message').length, 101, 'the head, 99 followers and the other chat; the 100th follower hit the cap')
 assert.equal(h.reports.length, 1); assert.match(h.reports[0], /1 guild over the 100-event hold cap/); assert.doesNotMatch(h.reports[0], new RegExp(room))
})
test('chatter does not consume the hold cap', async t => {
 clock(t); const h = harness(t, { rest: limitOnce(1000) }); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', mention()); await settle()
 for (let i = 0; i < 120; i++) h.dispatch('MESSAGE_CREATE', message({ channel_id: room, guild_id: guild, content: `chatter ${i}` }))
 h.dispatch('MESSAGE_CREATE', mention()); await settle()
 t.mock.timers.tick(1000); await settle(20)
 assert.equal(h.accepted.length, 2); assert.deepEqual(h.reports, [])
})
test('stop returns promptly with input parked behind a hold', async t => {
 clock(t); const h = harness(t, { rest: limitOnce(30_000) }); const done = h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', mention()); h.dispatch('MESSAGE_CREATE', mention()); await settle()
 h.controller.abort(); await done
 assert.deepEqual(h.accepted, [])
})

const callback = script => { const queue = [...script]; let count = 0; const handler = async (method, path) => { if (path.includes('/callback')) { count++; const next = queue.shift(); if (next instanceof Error) throw next; if (next) return next(); return {} } }; handler.count = () => count; return handler }
test('a button is acknowledged at ingress, ahead of an earlier chat\'s stalled lookup', async t => {
 clock(t); let release; const stall = new Promise(r => { release = r })
 const h = harness(t, { rest: async (_m, path) => { if (path === `/channels/${room}`) { await stall; return { id: room, type: 0, guild_id: guild } } } }); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', mention()); await settle()
 h.dispatch('INTERACTION_CREATE', button()); await settle()
 assert.equal(h.calls.filter(c => c.path.includes('/callback')).length, 1, 'answered within Discord\'s deadline')
 assert.deepEqual(h.calls.find(c => c.path.includes('/callback')).body, { type: 6 })
 release(); await settle(); assert.equal(h.accepted.at(-1).kind, 'button')
})
test('an acknowledgement is not retried past its deadline, and the button is not admitted', async t => {
 clock(t); const handler = callback([limited(3000)]); const h = harness(t, { rest: handler }); h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', button()); const next = message(); h.dispatch('MESSAGE_CREATE', next); await settle()
 t.mock.timers.tick(3000); await settle()
 assert.equal(handler.count(), 1); assert.deepEqual(h.ids().filter(id => id.startsWith('interaction')), [])
 assert.equal(h.outcome(), undefined)
})
test('a briefly limited acknowledgement is retried within its deadline', async t => {
 clock(t); const handler = callback([limited(300)]); const h = harness(t, { rest: handler }); h.start(); await settle()
 const tap = button(); h.dispatch('INTERACTION_CREATE', tap); await settle()
 t.mock.timers.tick(300); await settle()
 assert.equal(handler.count(), 2); assert.deepEqual(h.ids(), [`interaction:${tap.id}`])
})
for (const kind of ['blocked', 'gone']) test(`a ${kind} acknowledgement is not retried or admitted`, async t => {
 clock(t); const handler = callback([failure(kind)]); const h = harness(t, { rest: handler }); h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', button()); const next = message(); h.dispatch('MESSAGE_CREATE', next); await settle()
 assert.equal(handler.count(), 1); assert.deepEqual(h.ids(), [`message:${next.id}`]); assert.equal(h.outcome(), undefined)
})
test('a 401 acknowledgement stops the session', async t => {
 clock(t); const h = harness(t, { rest: callback([failure('auth')]) }); const done = h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', button()); await done
 assert.equal(h.outcome().failure?.kind, 'auth')
})
test('a slow acknowledgement holds its own chat only', async t => {
 clock(t); let release; const slow = new Promise(r => { release = r })
 const h = harness(t, { rest: async (_m, path) => { if (path.includes('/callback')) { await slow; return {} } if (path === `/channels/${other}`) return { id: other, type: 1, recipients: [{ id: user }] } } }); h.start(); await settle()
 const tap = button(), follow = message(), elsewhere = message({ channel_id: other }); h.dispatch('INTERACTION_CREATE', tap); h.dispatch('MESSAGE_CREATE', follow); h.dispatch('MESSAGE_CREATE', elsewhere); await settle()
 assert.deepEqual(h.ids(), [`message:${elsewhere.id}`])
 release(); await settle(); assert.deepEqual(h.ids(), [`message:${elsewhere.id}`, `interaction:${tap.id}`, `message:${follow.id}`])
})
test('a native command\'s private defer is finished even when its channel cannot be served', async t => {
 clock(t); const h = harness(t, { rest: async (_m, path) => path === `/channels/${room}` ? { id: room, type: 11, guild_id: guild } : undefined }); h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', { id: String(++ids), application_id: bot, type: 2, token: 'fixture-token', channel_id: room, guild_id: guild, member: { user: human }, data: { name: 'tasks' } }); await settle()
 assert.deepEqual(h.accepted, [])
 assert.deepEqual(h.calls.find(c => c.path.startsWith('/webhooks/'))?.body, { content: 'Command received. If you have access, Cezar replies in this chat.', allowed_mentions: { parse: [] } })
})
test('losing a guild or channel emits removal; an outage does not', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('GUILD_CREATE', { id: guild, channels: [{ id: room, type: 0 }, { id: other, type: 0 }, { id: '30000000000000009', type: 2 }] })
 h.dispatch('GUILD_DELETE', { id: guild, unavailable: true }); await settle()
 assert.deepEqual(h.accepted, [])
 h.dispatch('GUILD_DELETE', { id: guild }); await settle()
 assert.deepEqual(h.accepted.map(e => [e.kind, e.reason, e.chat.id]), [['membership', 'removed', `discord:guild:${guild}:${room}`], ['membership', 'removed', `discord:guild:${guild}:${other}`]])
})
test('a removal for a channel seen only through a message is emitted once', async t => {
 clock(t); const h = harness(t); h.start(); await settle()
 h.dispatch('MESSAGE_CREATE', mention()); await settle()
 h.dispatch('CHANNEL_DELETE', { id: room, guild_id: guild, type: 0 }); h.dispatch('CHANNEL_DELETE', { id: room, guild_id: guild, type: 0 }); await settle()
 assert.equal(h.accepted.filter(e => e.kind === 'membership').length, 1)
})
const autocomplete = (data, extra = {}) => ({ id: String(++ids), application_id: bot, type: 4, token: 'fixture-token', channel_id: dm, user: human, data, ...extra })
test('autocomplete answers with the host choices', async t => {
 clock(t); const h = harness(t); h.session.openInteraction = async () => ({ taskChoices: async query => [{ name: query, value: 'task-id' }], dispose: async () => {} })
 h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', autocomplete({ name: 'tasks', options: [{ name: 'task', value: 'tas', focused: true }] })); await settle()
 assert.deepEqual(h.calls.find(c => c.path.includes('/callback')).body, { type: 8, data: { choices: [{ name: 'tas', value: 'task-id' }] } })
 assert.deepEqual(h.accepted, [])
})
test('autocomplete for another command or option is ignored', async t => {
 clock(t); const h = harness(t); let opened = 0; h.session.openInteraction = async () => { opened++; throw Error('unused') }
 h.start(); await settle()
 h.dispatch('INTERACTION_CREATE', autocomplete({ name: 'other', options: [{ name: 'task', value: 'tas', focused: true }] }))
 h.dispatch('INTERACTION_CREATE', autocomplete({ name: 'tasks', options: [{ name: 'other', value: 'tas', focused: true }] }))
 h.dispatch('MESSAGE_CREATE', message()); await settle()
 assert.equal(h.accepted.length, 1); assert.equal(opened, 0); assert.equal(h.calls.some(c => c.path.includes('/callback')), false)
})
