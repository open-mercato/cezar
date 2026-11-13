import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { createSlackReceiver, slackRequest } from '../dist/adapter.js'

const creds = { appToken: 'xapp-' + 'A'.repeat(20), botToken: 'xoxb-' + 'B'.repeat(20) }
const op = { signal: new AbortController().signal, assertActive: async () => {} }
const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
const stamp = (offset = 0) => `${Math.floor(Date.now() / 1000) + offset}.000001`
class Socket extends EventEmitter {
  readyState = 1; sent = []; pings = 0
  send(value) { this.sent.push(JSON.parse(value)) }
  ping() { this.pings++ }
  terminate() { this.readyState = 3; this.emit('close') }
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))) }
}
function harness(info = channel => ({ channel: { id: channel, is_im: channel.startsWith('D'), is_member: true } }), extra = {}) {
  const sockets = [], calls = []
  const adapter = createSlackReceiver(creds, async (method, body) => {
    calls.push(method)
    if (extra[method]) return extra[method](body)
    if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' }
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/x' }
    if (method === 'conversations.info') return info(body.channel)
    return { ok: true, channel: body.channel, ts: '1800000001.000001' }
  }, { lookup, socket: () => { const s = new Socket(); sockets.push(s); queueMicrotask(() => s.emit('open')); return s } })
  const lookups = () => calls.filter(method => method === 'conversations.info').length
  return { adapter, sockets, calls, lookups, socket: () => sockets.at(-1) }
}
let envelopes = 0
const event = (extra = {}) => ({ envelope_id: `env-${++envelopes}`, type: 'events_api', payload: { team_id: 'T1', event_id: `Ev${envelopes}`, event_time: Date.now() / 1000, authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', user: 'U2', channel: 'C1', channel_type: 'channel', ts: stamp(), text: '<@U1> hi', ...extra } } })
async function pull(h, frame, after = null) {
  const pending = h.adapter.receive(after, op); await turn(); await turn()
  h.socket().frame(frame)
  return pending
}

test('identify uses the namespaced id the core derives Slack links from', async () => {
  const h = harness(undefined, { 'auth.test': () => ({ team_id: 'T1', user_id: 'U1', user: 'cezar' }) })
  assert.deepEqual(await h.adapter.identify(op), { id: 'T1:U1', username: 'T1:U1', discoveryUrl: 'https://api.slack.com/apps' })
  await h.adapter.dispose()
})
test('identify refuses a response outside the Slack id shapes', async () => {
  for (const response of [{ team_id: 'E1', user_id: 'U1' }, { team_id: 'T1', user_id: 'B1' }, { team_id: 't1', user_id: 'U1' }]) {
    const h = harness(undefined, { 'auth.test': () => response })
    await assert.rejects(h.adapter.identify(op), /blocked/)
    await h.adapter.dispose()
  }
})
const wire = (statusCode, value, headers = {}) => slackRequest(creds, { lookup, request: async () => ({ statusCode, headers, body: Readable.from(value === undefined ? [] : [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]) }) })
test('Web API errors classify by Slack error code', async () => {
  const kinds = { not_authed: 'auth', account_inactive: 'auth', invalid_auth: 'auth', too_many_connections: 'conflict', ratelimited: 'rate_limited', not_in_channel: 'gone', internal_error: 'transient', service_unavailable: 'transient', request_timeout: 'transient', fatal_error: 'transient', msg_too_long: 'blocked' }
  for (const [error, kind] of Object.entries(kinds)) await assert.rejects(wire(200, { ok: false, error })('auth.test', {}, op), e => e.failure?.kind === kind, error)
})
test('HTTP failures classify before the body is parsed and honor retry-after', async () => {
  await assert.rejects(wire(429, undefined, { 'retry-after': '2' })('chat.postMessage', {}, op), e => e.failure?.kind === 'rate_limited' && e.failure.retryAfterMs === 2000)
  await assert.rejects(wire(429, undefined, { 'retry-after': '99999' })('chat.postMessage', {}, op), e => e.failure?.retryAfterMs === 3_600_000)
  await assert.rejects(wire(429, undefined)('chat.postMessage', {}, op), e => e.failure?.retryAfterMs === 5000)
  await assert.rejects(wire(401, '<html>')('auth.test', {}, op), e => e.failure?.kind === 'auth')
  await assert.rejects(wire(503, '<html>')('auth.test', {}, op), e => e.failure?.kind === 'transient')
  await assert.rejects(wire(404, '<html>')('auth.test', {}, op), e => e.failure?.kind === 'blocked')
})
test('a missed request deadline is transient, an operation abort is blocked', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hung = slackRequest(creds, { lookup, request: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  const rejected = assert.rejects(hung('auth.test', {}, op), e => e.failure?.kind === 'transient')
  await turn(); await turn(); t.mock.timers.tick(10_000); await rejected
  const controller = new AbortController()
  const pending = assert.rejects(hung('auth.test', {}, { signal: controller.signal, assertActive: async () => {} }), e => e.failure?.kind === 'blocked')
  await turn(); await turn(); controller.abort(); await pending
})
test('an envelope is ACKed on arrival, before serialized lookup work', async () => {
  let release
  const h = harness(channel => new Promise(resolve => { release = () => resolve({ channel: { id: channel, is_im: false, is_member: true } }) }))
  const pending = h.adapter.receive(null, op); await turn(); await turn()
  h.socket().frame(event()); h.socket().frame(event({ ts: stamp(), text: '<@U1> second' }))
  assert.equal(h.socket().sent.length, 2, 'both envelopes ACKed while the first lookup hangs')
  await turn(); release(); await pending
  await h.adapter.dispose()
})
test('a socket over capacity leaves the envelope un-ACKed for redelivery', async () => {
  const h = harness()
  const pending = h.adapter.receive(null, op); await turn(); await turn()
  const socket = h.socket()
  for (let n = 0; n < 101; n++) socket.frame(event())
  assert.equal(socket.sent.length, 100)
  assert.equal(socket.readyState, 3)
  await pending; await h.adapter.dispose()
})
test('unaddressed channel chatter costs no lookup, and identity is cached', async () => {
  const h = harness()
  let batch = await pull(h, event({ text: 'chatter' }))
  assert.equal(batch[0].event, undefined); assert.equal(h.lookups(), 0)
  batch = await pull(h, event({ text: '<@U1> a' }), batch[0].sequence)
  assert.equal(batch[0].event.kind, 'message'); assert.equal(h.lookups(), 1)
  batch = await pull(h, event({ text: '<@U1> b' }), batch[0].sequence)
  assert.equal(batch[0].event.kind, 'message'); assert.equal(h.lookups(), 1)
  batch = await pull(h, event({ text: 'threaded', thread_ts: '1799999999.000001' }), batch[0].sequence)
  assert.equal(batch[0].event.replyTo.messageId, '1799999999.000001')
  batch = await pull(h, event({ text: 'undeclared', channel_type: undefined }), batch[0].sequence)
  assert.equal(batch[0].event, undefined, 'looked up, then dropped as unaddressed group text')
  await h.adapter.dispose()
})
test('the identity cache expires, drops on leaving, and never serves authorization', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  let joined = true
  const h = harness(channel => ({ channel: { id: channel, is_im: false, is_member: joined } }), { 'conversations.members': () => ({ members: ['U2'] }) })
  let batch = await pull(h, event())
  assert.equal(h.lookups(), 1)
  batch = await pull(h, event({ ts: stamp() }), batch[0].sequence)
  assert.equal(h.lookups(), 1, 'served from the cache inside its TTL')
  t.mock.timers.tick(10 * 60_000)
  batch = await pull(h, event({ ts: stamp() }), batch[0].sequence)
  assert.equal(h.lookups(), 2)
  batch = await pull(h, { envelope_id: 'left', type: 'events_api', payload: { team_id: 'T1', event_id: 'Left', event_time: Date.now() / 1000, authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'channel_archive', channel: 'C1' } } }, batch[0].sequence)
  batch = await pull(h, event({ ts: stamp() }), batch[0].sequence)
  assert.equal(h.lookups(), 3)
  joined = false
  assert.equal(await h.adapter.isMember('group:T1:U1:C1', 'U2', op), false)
  assert.equal(h.lookups(), 4)
  await h.adapter.dispose()
})
test('a rate-limited or gone channel drops one event, keeps the socket and spends no further lookups', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  let limited = true
  const h = harness(channel => { if (channel === 'C9') throw new ExtensionChatError({ kind: 'gone' }); if (limited) throw new ExtensionChatError({ kind: 'rate_limited', retryAfterMs: 30_000 }); return { channel: { id: channel, is_im: channel.startsWith('D'), is_member: true } } })
  let batch = await pull(h, event())
  assert.equal(batch[0].event, undefined); assert.equal(h.lookups(), 1)
  batch = await pull(h, event({ channel: 'D1', channel_type: 'im' }), batch[0].sequence)
  assert.equal(batch[0].event, undefined); assert.equal(h.lookups(), 1, 'inside the retry-after window')
  t.mock.timers.tick(31_000); limited = false
  batch = await pull(h, event({ channel: 'C9' }), batch[0].sequence)
  assert.equal(batch[0].event, undefined); assert.equal(h.lookups(), 2)
  batch = await pull(h, event({ channel: 'D1', channel_type: 'im', ts: stamp() }), batch[0].sequence)
  assert.equal(batch[0].event.chat.id, 'private:T1:U1:D1')
  assert.equal(h.sockets.length, 1)
  await h.adapter.dispose()
})
test('events the host would refuse are ignored instead of killing the session', async () => {
  const h = harness()
  let batch = await pull(h, event({ user: 'B1' }))
  assert.equal(batch[0].event, undefined)
  batch = await pull(h, event({ channel: 'X1' }), batch[0].sequence)
  assert.equal(batch[0].event, undefined)
  await h.adapter.dispose()
})
test('deliveries older than the first connection are refused, including after a reconnect', async () => {
  const h = harness()
  let batch = await pull(h, event({ ts: stamp(-120) }))
  assert.equal(batch[0].event, undefined, 'a retransmission from before this process started')
  await h.adapter.dispose()
})
test('a refresh disconnect reconnects after a pause, not in a hot loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
  const h = harness()
  const pending = h.adapter.receive(null, op); await turn(); await turn()
  h.socket().frame({ type: 'disconnect', reason: 'refresh_requested' })
  await turn(); await turn()
  assert.equal(h.sockets.length, 1, 'waits before redialing')
  t.mock.timers.tick(999); await turn(); await turn()
  assert.equal(h.sockets.length, 1)
  t.mock.timers.tick(1); await turn(); await turn(); await turn(); await turn()
  assert.equal(h.sockets.length, 2)
  h.socket().frame(event())
  assert.equal((await pending)[0].event.kind, 'message')
  await h.adapter.dispose()
})
test('link_disabled is terminal', async () => {
  const h = harness()
  const pending = h.adapter.receive(null, op); await turn(); await turn()
  h.socket().frame({ type: 'disconnect', reason: 'link_disabled' })
  await assert.rejects(pending, e => e.failure?.kind === 'blocked')
  assert.equal(h.sockets.length, 1)
  await h.adapter.dispose()
})
test('the socket is pinged and a silent one is dropped after 90 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
  const h = harness()
  const pending = h.adapter.receive(null, op).catch(() => undefined); await turn(); await turn()
  const socket = h.socket()
  t.mock.timers.tick(30_000); assert.equal(socket.pings, 1)
  socket.emit('pong')
  t.mock.timers.tick(60_000); assert.equal(socket.readyState, 1, 'a pong keeps it alive')
  t.mock.timers.tick(60_000); assert.equal(socket.readyState, 3)
  await h.adapter.dispose(); await pending
})
const recording = (history = { messages: [] }, replies = { messages: [] }) => {
  const updates = [], h = harness(undefined, { 'conversations.history': () => history, 'conversations.replies': () => replies, 'chat.update': body => { updates.push(body); return { ok: true } } })
  return { h, updates }
}
const receipt = { chatId: 'group:T1:U1:C1', messageId: '1800000001.000001' }
test('clearing buttons keeps the posted text and sections', async () => {
  const { h, updates } = recording()
  await h.adapter.identify(op)
  await h.adapter.clearButtons(await h.adapter.send(receipt.chatId, { text: 'Choose & go', buttons: [[{ text: 'Yes', data: 'y' }]] }, op), op)
  assert.deepEqual(updates, [{ channel: 'C1', ts: receipt.messageId, text: 'Choose &amp; go', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Choose &amp; go', verbatim: true } }] }])
  assert.equal(h.calls.includes('conversations.history'), false)
  await h.adapter.dispose()
})
test('after a restart its own message is recovered, a threaded reply too, and an unreadable one is left alone', async () => {
  const own = { ts: receipt.messageId, user: 'U1', text: 'Earlier' }
  let r = recording({ messages: [own] })
  await r.h.adapter.clearButtons(receipt, op); assert.equal(r.updates[0].text, 'Earlier'); await r.h.adapter.dispose()
  r = recording({ messages: [] }, { messages: [{ ts: '1700000000.000001', user: 'U2', text: 'root' }, own] })
  await r.h.adapter.clearButtons(receipt, op); assert.equal(r.updates[0].text, 'Earlier'); await r.h.adapter.dispose()
  for (const history of [{ messages: [] }, { messages: [{ ...own, user: 'U2' }] }]) {
    r = recording(history)
    await r.h.adapter.clearButtons(receipt, op); assert.deepEqual(r.updates, []); await r.h.adapter.dispose()
  }
})
test('a malformed thread root is refused before sending', async () => {
  const h = harness(); await h.adapter.identify(op)
  await assert.rejects(h.adapter.send(receipt.chatId, { text: 'x', replyTo: { chatId: receipt.chatId, messageId: 'not-a-ts' } }, op), /blocked/)
  assert.equal(h.calls.includes('chat.postMessage'), false)
  await h.adapter.dispose()
})
test('membership stays unknown when identity or namespace cannot be checked', async () => {
  const h = harness(); await h.adapter.identify(op)
  assert.equal(await h.adapter.isMember('group:T9:U1:C1', 'U2', op), undefined)
  await h.adapter.dispose()
  const failing = harness(undefined, { 'auth.test': () => { throw new ExtensionChatError({ kind: 'transient' }) } })
  assert.equal(await failing.adapter.isMember('group:T1:U1:C1', 'U2', op), undefined)
  await failing.adapter.dispose()
})
test('bot, edited, stale, self and cross-workspace messages are ignored', async () => {
  const h = harness()
  let after = null
  for (const extra of [{ bot_id: 'B1' }, { subtype: 'message_changed' }, { ts: stamp(-1000) }, { ts: stamp(120) }, { user: 'U1' }]) {
    const batch = await pull(h, event(extra), after)
    assert.equal(batch[0].event, undefined, JSON.stringify(extra)); after = batch[0].sequence
  }
  for (const patch of [{ team_id: 'T2' }, { authorizations: [{ user_id: 'U9', is_bot: true }] }]) {
    const frame = event(); Object.assign(frame.payload, patch)
    const batch = await pull(h, frame, after)
    assert.equal(batch[0].event, undefined, JSON.stringify(patch)); after = batch[0].sequence
  }
  await h.adapter.dispose()
})
test('a thread root becomes the reply target and a /start code stays addressed', async () => {
  const h = harness()
  let batch = await pull(h, event({ text: 'x', thread_ts: '1799999999.000001' }))
  assert.equal(batch[0].event.addressed, false); assert.deepEqual(batch[0].event.replyTo, { chatId: 'group:T1:U1:C1', messageId: '1799999999.000001' })
  batch = await pull(h, event({ text: '<@U1> cezar start abc_123' }), batch[0].sequence)
  assert.equal(batch[0].event.text, '/start abc_123'); assert.equal(batch[0].event.addressed, true)
  await h.adapter.dispose()
})
test('inspect verifies the private/group namespace against Slack', async () => {
  const h = harness(); await h.adapter.identify(op)
  assert.equal((await h.adapter.inspect('private:T1:U1:D1', op)).kind, 'private')
  assert.equal((await h.adapter.inspect('group:T1:U1:G1', op)).kind, 'group')
  await assert.rejects(h.adapter.inspect('private:T1:U1:G1', op), /blocked/)
  await assert.rejects(h.adapter.send('private:T1:U9:D1', { text: 'secret' }, op), /blocked/)
  await h.adapter.dispose()
})
