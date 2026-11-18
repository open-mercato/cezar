// Identify budget and same-chat hold budget.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { createDiscordAdapter } from '../dist/adapter.js'

const bot = '10000000000000001', chat = '30000000000000003', user = '40000000000000004'
const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)) }
const limit = (remaining, reset_after = 60000) => ({ url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining, reset_after } })

function harness(t, { gateway, rest }) {
 t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 })
 t.mock.method(Math, 'random', () => 0.5)
 const s = { sockets: [], accepted: [], calls: [], reports: [], states: [], controller: new AbortController() }
 class Socket extends EventEmitter {
  sent = []; readyState = 1
  send(value) { const sent = JSON.parse(value); this.sent.push(sent); if (sent.op === 1) this.frame({ op: 11 }) }
  terminate() { this.readyState = 3; this.emit('close', 1006) }
  close() { this.terminate() }
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))) }
 }
 const request = async (method, path, body, op) => {
  s.calls.push(path)
  const answer = await rest?.(method, path, body, op)
  if (answer !== undefined) return answer
  if (path === '/users/@me') return { id: bot, bot: true }
  if (path === '/gateway/bot') return gateway()
  if (path.startsWith('/channels/')) return { id: path.split('/')[2], type: 1, recipients: [{ id: user }] }
  return {}
 }
 const dial = () => { const socket = new Socket(); s.sockets.push(socket); return socket }
 s.adapter = createDiscordAdapter({ token: 'fixture' }, request, dial, async () => [{ address: '162.159.135.232', family: 4 }], async message => { s.reports.push(message) })
 s.session = { signal: s.controller.signal, assertActive: async () => s.controller.signal.throwIfAborted(), accept: async delivery => { s.accepted.push(delivery.event.text) }, health: async value => { s.states.push(value.state) } }
 s.hello = socket => socket.frame({ op: 10, d: { heartbeat_interval: 45000 } })
 s.ready = socket => { s.hello(socket); socket.frame({ op: 0, s: 1, t: 'READY', d: { session_id: 'session', user: { id: bot, bot: true } } }) }
 s.discoveries = () => s.calls.filter(path => path === '/gateway/bot').length
 s.lookups = () => s.calls.filter(path => path.startsWith('/channels/')).length
 s.advance = async (ms, step = 1000) => { for (let at = 0; at < ms; at += step) { t.mock.timers.tick(step); await settle(4) } }
 s.finish = async pending => { s.controller.abort(); await s.adapter.dispose(); await pending }
 s.start = () => { s.outcome = undefined; return s.adapter.receiveSession(s.session).then(() => { s.outcome = 'resolved' }, error => { s.outcome = `rejected ${error.failure?.kind}` }) }
 return s
}

test('a spent identify budget at boot backs off, then rediscovers and identifies', async t => {
 const limits = [limit(0), limit(1)]
 const s = harness(t, { gateway: () => limits.length > 1 ? limits.shift() : limits[0] })
 const pending = s.start(); await settle()
 assert.equal(s.outcome, undefined, 'a spent budget never ends the session')
 assert.equal(s.discoveries(), 1, 'discovery runs before the budget check')
 assert.equal(s.sockets.length, 0, 'no socket without budget')
 assert.ok(s.states.includes('backoff'), 'health says so')
 await s.advance(59000)
 assert.equal(s.discoveries(), 1); assert.equal(s.sockets.length, 0)
 await s.advance(2000)
 assert.equal(s.discoveries(), 2); assert.equal(s.sockets.length, 1)
 s.hello(s.sockets[0]); await settle()
 assert.equal(s.sockets[0].sent.at(-1).op, 2, 'identifies once the budget refilled')
 assert.equal(s.outcome, undefined)
 await s.finish(pending)
})

test('a budget still spent after the refresh backs off again without dialling', async t => {
 const limits = [limit(1, 1000), limit(0, 60000), limit(1)]
 const s = harness(t, { gateway: () => limits.length > 1 ? limits.shift() : limits[0] })
 const pending = s.start(); await settle()
 s.ready(s.sockets[0]); await settle()
 s.sockets[0].frame({ op: 9, d: false }); await settle()
 await s.advance(6000)
 assert.equal(s.discoveries(), 2, 'the expired window refreshes')
 assert.equal(s.sockets.length, 1, 'no dial while the refreshed budget is spent')
 assert.equal(s.outcome, undefined)
 await s.advance(60000)
 assert.equal(s.discoveries(), 3); assert.equal(s.sockets.length, 2)
 s.hello(s.sockets[1]); await settle()
 assert.equal(s.sockets[1].sent.at(-1).op, 2)
 assert.equal(s.outcome, undefined)
 await s.finish(pending)
})

test('a spent budget with no reset_after still waits before rediscovering', async t => {
 const s = harness(t, { gateway: () => limit(0, 0) })
 const pending = s.start(); await settle()
 assert.equal(s.discoveries(), 1)
 await s.advance(500, 100)
 assert.equal(s.discoveries(), 1, 'a one second floor, never a hot loop')
 await s.advance(1000, 100)
 assert.equal(s.discoveries(), 2)
 assert.equal(s.outcome, undefined)
 await s.finish(pending)
})

test('a session with resume state ignores a spent identify budget', async t => {
 const limits = [limit(1)]
 const s = harness(t, { gateway: () => limits[0] })
 const pending = s.start(); await settle()
 s.ready(s.sockets[0]); await settle()
 s.sockets[0].frame({ op: 7 }); await settle()
 await s.advance(6000)
 assert.equal(s.sockets.length, 2); assert.equal(s.discoveries(), 1)
 s.hello(s.sockets[1]); await settle()
 assert.equal(s.sockets[1].sent.at(-1).op, 6)
 await s.finish(pending)
})

const limited = () => new ExtensionChatError({ kind: 'rate_limited', retryAfterMs: 40000 })
const message = (id, text) => ({ id, channel_id: chat, author: { id: user, username: 'u' }, content: text, timestamp: '2027-01-15T08:00:00.000Z' })
const dispatch = (socket, n) => socket.frame({ op: 0, s: 2 + n, t: 'MESSAGE_CREATE', d: message(`8000000000000000${n}`, `m${n}`) })
const alwaysLimited = async (_method, path) => { if (path.startsWith('/channels/')) throw limited() }

for (const [name, between] of [['joining a parked lane', () => settle()], ['queued before the lane parked', async () => {}]]) test(`records ${name} spend the hold budget from then, not from their own first 429`, async t => {
 const s = harness(t, { gateway: () => limit(10), rest: alwaysLimited })
 const pending = s.start(); await settle(); s.ready(s.sockets[0]); await settle()
 for (let n = 0; n < 5; n++) { dispatch(s.sockets[0], n); await between() }
 await settle()
 assert.equal(s.lookups(), 1, 'only the head looks up while the lane is parked')
 await s.advance(40000)
 assert.equal(s.lookups(), 6, 'each record gets one last look at 40 s and none fits another 40 s wait')
 await s.advance(440000)
 assert.equal(s.lookups(), 6, 'nothing is left in the lane')
 assert.match(s.reports.join(' '), /hold budget/)
 await s.finish(pending)
})

test('a late joiner gets its own budget, measured from when it joined', async t => {
 const s = harness(t, { gateway: () => limit(10), rest: alwaysLimited })
 const pending = s.start(); await settle(); s.ready(s.sockets[0]); await settle()
 dispatch(s.sockets[0], 0); await settle()
 await s.advance(30000)
 dispatch(s.sockets[0], 1); await settle()
 await s.advance(10000)
 assert.equal(s.lookups(), 3, 'head dropped at 40 s; the joiner looks up')
 await s.advance(30000)
 assert.equal(s.lookups(), 3, 'joined at 30 s, so a 40 s hold fits its 60 s budget')
 await s.advance(10000)
 assert.equal(s.lookups(), 4, 'retried at 80 s and past budget')
 await s.advance(120000)
 assert.equal(s.lookups(), 4)
 await s.finish(pending)
})
