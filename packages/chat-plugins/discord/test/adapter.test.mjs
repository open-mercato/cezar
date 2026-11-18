import test from 'node:test'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { discordRequest, createDiscordReceiver } from '../dist/adapter.js'
import { parseChat } from '../dist/identity.js'
test('rejects private DNS answers', async () => { await assert.rejects(discordRequest('x'.repeat(60), { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })('GET', '/users/@me'), e => e.failure?.kind === 'blocked') })
test('rejects CGNAT and benchmarking DNS answers before the REST request', async () => {
 for (const address of ['100.64.0.1', '100.127.255.254', '198.18.0.1', '198.19.255.254']) {
  let requested = false
  const request = async () => { requested = true; throw new Error('must not request') }
  await assert.rejects(discordRequest('x', { lookup: async () => [{ address, family: 4 }], request })('GET', '/users/@me'), e => e.failure?.kind === 'blocked')
  assert.equal(requested, false, address)
 }
})
test('rejects unsafe IPv6 and mapped IPv4 DNS answers', async () => {
 for (const address of ['::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '2001:db8::1']) {
  await assert.rejects(discordRequest('x', { lookup: async () => [{ address, family: 6 }] })('GET', '/users/@me'), e => e.failure?.kind === 'blocked')
 }
})
test('cancels a hung REST DNS lookup when the operation aborts', async () => {
 let lookupSignal
 const request = discordRequest('x', { lookup: async (_host, signal) => { lookupSignal = signal; await new Promise(() => {}) } })
 const controller = new AbortController()
 const pending = request('GET', '/users/@me', undefined, { signal: controller.signal, assertActive: async () => {} })
 await new Promise(resolve => setTimeout(resolve, 10))
 controller.abort()
 await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('lookup did not cancel')), 250))]), e => e.failure?.kind === 'blocked')
 assert.equal(lookupSignal?.aborted, true)
})
test('canonical chat ids reject extra and malformed segments', () => {
 assert.throws(() => parseChat('discord:dm:12345678901234567:extra'))
 assert.throws(() => parseChat('discord:guild:12345678901234567'))
 assert.throws(() => parseChat('discord:guild:12345678901234567:01234567890123456'))
 assert.equal(parseChat('discord:guild:12345678901234567:22345678901234567').kind, 'group')
})
test('REST gateway discovery rejects a non-Discord websocket host', async () => {
 const request = async (_method, path) => path === '/gateway/bot' ? { url: 'wss://evil.example/', shards: 1, session_start_limit: { remaining: 1000 } } : {}
 const adapter = createDiscordReceiver({ token: 'x' }, request)
 await assert.rejects(adapter.receive(null), e => e.failure?.kind === 'blocked')
})
test('Gateway DNS is checked before a WebSocket dial', async () => {
 for (const address of ['127.0.0.1', '100.64.0.1', '198.19.255.254']) {
  let dialed = false
  const request = async (_method, path) => path === '/gateway/bot' ? { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } } : {}
  const adapter = createDiscordReceiver({ token: 'x' }, request, () => { dialed = true; throw new Error('must not dial') }, async () => [{ address, family: 4 }])
  await assert.rejects(adapter.receive(null), e => e.failure?.kind === 'blocked')
  assert.equal(dialed, false, address)
 }
})

test('cancels a hung Gateway DNS lookup when the operation aborts', async () => {
 let lookupSignal
 const request = async (_method, path) => path === '/gateway/bot' ? { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } } : {}
 const adapter = createDiscordReceiver({ token: 'x' }, request, undefined, async (_host, signal) => {
  lookupSignal = signal
  await new Promise(() => {})
 })
 const controller = new AbortController()
 const pending = adapter.receive(null, { signal: controller.signal, assertActive: async () => {} })
 await new Promise(resolve => setTimeout(resolve, 10))
 controller.abort()
 await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('lookup did not cancel')), 250))]), e => e.failure?.kind === 'blocked')
 assert.equal(lookupSignal?.aborted, true)
})

test('rejects an interaction whose message belongs to another channel', async () => {
 class FakeSocket extends EventEmitter {
  terminate() { this.emit('close') }
  close() { this.emit('close') }
  send() {}
 }
 let socket
 let callbacks = 0
 const request = async (_method, path) => {
  if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } }
  if (path.includes('/callback')) callbacks++
  if (path.startsWith('/channels/')) return { id: '30000000000000003', type: 0, guild_id: '70000000000000007', permission_overwrites: [] }
  return {}
 }
 const adapter = createDiscordReceiver({ token: 'x' }, request, () => {
  socket = new FakeSocket()
  queueMicrotask(() => {
   socket.emit('open')
   socket.emit('message', Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } })))
   socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: '10000000000000001', bot: true }, session_id: 'session' } })))
   queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: '20000000000000002', application_id: '10000000000000001', type: 3, token: 'token', channel_id: '30000000000000003', user: { id: '40000000000000004', username: 'human' }, data: { custom_id: 'button' }, message: { id: '50000000000000005', channel_id: '60000000000000006', author: { id: '10000000000000001', bot: true } } } }))))
  })
  return socket
 }, async () => [{ address: '8.8.8.8', family: 4 }])
 const batch = await adapter.receive(null)
 assert.equal(callbacks, 0)
 assert.deepEqual(batch, [{ sequence: 1 }])
 await adapter.dispose()
})

test('acknowledges a component before a delayed channel lookup', async () => {
 class FakeSocket extends EventEmitter {
  terminate() { this.emit('close') }
  close() { this.emit('close') }
  send() {}
 }
 let socket
 let callbackAt = 0
 let lookupReleased
 const lookupDone = new Promise(resolve => { lookupReleased = resolve })
 const request = async (_method, path) => {
  if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } }
  if (path.includes('/callback')) { callbackAt = Date.now(); return {} }
  if (path.startsWith('/channels/')) {
   await lookupDone
   return { id: '30000000000000003', type: 0, guild_id: '70000000000000007', permission_overwrites: [] }
  }
  return {}
 }
 const adapter = createDiscordReceiver({ token: 'x' }, request, () => {
  socket = new FakeSocket()
  queueMicrotask(() => {
   socket.emit('open')
   socket.emit('message', Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } })))
   socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: '10000000000000001', bot: true }, session_id: 'session' } })))
   setTimeout(() => socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: '20000000000000002', application_id: '10000000000000001', type: 3, token: 'token', channel_id: '30000000000000003', guild_id: '70000000000000007', user: { id: '40000000000000004', username: 'human' }, data: { custom_id: 'button' }, message: { id: '50000000000000005', channel_id: '30000000000000003', author: { id: '10000000000000001', bot: true } } } }))), 10)
  })
  return socket
 }, async () => [{ address: '8.8.8.8', family: 4 }])
 const started = Date.now()
 const pending = adapter.receive(null)
 while (!callbackAt && Date.now() - started < 1000) await new Promise(resolve => setTimeout(resolve, 1))
 assert.ok(callbackAt, 'interaction callback was not requested promptly')
 assert.ok(callbackAt - started < 1000, `callback took ${callbackAt - started}ms`)
 lookupReleased()
 const batch = await pending
 assert.equal(batch[0]?.event?.kind, 'button')
 await adapter.dispose()
})

test('Discord keeps replies to bot receipts and normalizes native commands', async () => {
 class FakeSocket extends EventEmitter { terminate() { this.emit('close') } close() { this.emit('close') } send() {} }
 let socket
 const request = async (_method, path) => {
  if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } }
  if (path.startsWith('/channels/')) return { id: '30000000000000003', type: 0, guild_id: '70000000000000007', permission_overwrites: [] }
  return {}
 }
 const adapter = createDiscordReceiver({ token: 'x' }, request, () => {
  socket = new FakeSocket()
  queueMicrotask(() => {
   socket.emit('open')
   socket.emit('message', Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } })))
   socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: '10000000000000001', username: 'bot', bot: true }, session_id: 'session' } })))
   queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '80000000000000008', channel_id: '30000000000000003', guild_id: '70000000000000007', author: { id: '40000000000000004', username: 'human' }, content: 'reply', timestamp: new Date().toISOString(), message_reference: { message_id: '50000000000000005', channel_id: '30000000000000003' }, referenced_message: { id: '50000000000000005', channel_id: '30000000000000003', author: { id: '10000000000000001', username: 'bot', bot: true } } } }))))
  })
  return socket
 }, async () => [{ address: '8.8.8.8', family: 4 }])
 const batch = await adapter.receive(null)
 assert.deepEqual(batch[0].event.replyTo, { chatId: 'discord:guild:70000000000000007:30000000000000003', messageId: '50000000000000005' })
 await adapter.dispose()
})

test('calls to one address reuse a pooled dispatcher instead of a new TLS handshake', async () => {
 const dispatchers = []
 let address = '8.8.4.1'
 const call = discordRequest('token', { lookup: async () => [{ address, family: 4 }], request: async (_url, request) => { dispatchers.push(request.dispatcher); return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('{}')]) } } })
 await call('GET', '/users/@me'); await call('GET', '/users/@me')
 assert.equal(new Set(dispatchers).size, 1)
 assert.equal(dispatchers[0].closed, false, 'stays open for the next call')
 address = '8.8.4.2'; await call('GET', '/users/@me')
 assert.equal(new Set(dispatchers).size, 2, 'a different validated address never shares a pinned agent')
})
