// An envelope is ACKed at arrival, so Slack will not resend it.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { createSlackAdapter } from '../dist/adapter.js'

const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)) }
const frame = (id, n, channel = 'C1') => Buffer.from(JSON.stringify({ envelope_id: id, type: 'events_api', payload: { team_id: 'T1', authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', channel, user: 'U2', ts: `18000000${24 + n}.000001`, text: `<@U1> /task ${id}` } } }))

function setup(t, { info, token, accept, socketOpens = true } = {}) {
 t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 })
 const state = { acks: [], accepted: [], sockets: [], reports: [], tokens: [] }
 class Socket extends EventEmitter {
  readyState = 1
  send(value) { state.acks.push(JSON.parse(value).envelope_id) }
  terminate() { this.readyState = 3; this.emit('close') }
  ping() {}
 }
 const wire = async (method, body) => {
  if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' }
  if (method === 'apps.connections.open') return { url: 'wss://slack.com/socket' }
  if (method === 'conversations.info') { await info?.(body); return { channel: { id: body.channel, is_im: false, is_member: true } } }
  throw Error(method)
 }
 const options = {
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  socket: () => { const socket = new Socket(); state.sockets.push(socket); if (socketOpens) queueMicrotask(() => socket.emit('open')); return socket },
  report: message => state.reports.push(message),
 }
 const services = token ? { credentials: { accessToken: async slot => { state.tokens.push(slot); return token(slot) } } } : undefined
 state.adapter = createSlackAdapter({ appToken: 'xapp-1234567890', botToken: 'xoxb-1234567890' }, wire, options, services)
 state.session = () => {
  const controller = new AbortController()
  return { controller, signal: controller.signal, assertActive: async () => controller.signal.throwIfAborted(), health: async () => {},
   accept: async delivery => { await accept?.(delivery, state); state.accepted.push(delivery.event.text) } }
 }
 return state
}
const transient = () => new ExtensionChatError({ kind: 'transient' })

for (const failedSlot of ['app', 'bot']) test(`every ACKed event reaches acceptance before ${failedSlot} renewal fails`, async t => {
 const seenAtAccept = []
 const s = setup(t, {
  token: async slot => { if (slot === failedSlot) throw Error('renewal unavailable'); return 'fixture-token' },
  accept: async (_delivery, state) => { seenAtAccept.push(state.tokens.length) },
 })
 const pending = s.adapter.receiveSession(s.session()); await settle()
 t.mock.timers.tick(24000)
 s.sockets[0].emit('message', frame('e1', 0)); s.sockets[0].emit('message', frame('e2', 1)); s.sockets[0].emit('message', frame('e3', 2))
 await assert.rejects(pending, /renewal unavailable/)
 assert.deepEqual(s.acks, ['e1', 'e2', 'e3'])
 assert.deepEqual(s.accepted, ['/task e1', '/task e2', '/task e3'])
 assert.deepEqual(seenAtAccept, [0, 0, 0], 'renewal waits for the drained queue')
 await s.adapter.dispose()
})

test('a transient lookup keeps the failed head and the queue for the next session', async t => {
 let fails = 1
 const s = setup(t, { info: async () => { if (fails-- > 0) throw transient() } })
 const first = s.session(), pending = s.adapter.receiveSession(first); await settle()
 s.sockets[0].emit('message', frame('e1', 0)); s.sockets[0].emit('message', frame('e2', 1, 'C2'))
 await assert.rejects(pending, /transient/)
 assert.deepEqual(s.accepted, [])
 const second = s.session(), restarted = s.adapter.receiveSession(second); await settle()
 assert.deepEqual(s.accepted, ['/task e1', '/task e2'])
 assert.deepEqual(s.acks, ['e1', 'e2'], 'nothing was redelivered or re-ACKed')
 second.controller.abort(); await restarted.catch(() => undefined); await s.adapter.dispose()
})

test('a failed acceptance keeps the event for the next session, in order', async t => {
 let fails = 1
 const s = setup(t, { accept: async () => { if (fails-- > 0) throw transient() } })
 const pending = s.adapter.receiveSession(s.session()); await settle()
 s.sockets[0].emit('message', frame('e1', 0)); s.sockets[0].emit('message', frame('e2', 1))
 await assert.rejects(pending, /transient/)
 const second = s.session(), restarted = s.adapter.receiveSession(second); await settle()
 assert.deepEqual(s.accepted, ['/task e1', '/task e2'])
 second.controller.abort(); await restarted.catch(() => undefined); await s.adapter.dispose()
})

test('stop discards what is ACKed and unaccepted, reports the count and never replays it', async t => {
 let release, entered; const inAccept = new Promise(resolve => { entered = resolve })
 const s = setup(t, { accept: async delivery => { if (delivery.event.text === '/task e1') { entered(); await new Promise(resolve => { release = resolve }) } } })
 const first = s.session(), pending = s.adapter.receiveSession(first); await settle()
 s.sockets[0].emit('message', frame('e1', 0)); s.sockets[0].emit('message', frame('e2', 1))
 await inAccept
 first.controller.abort(); release()
 await pending.catch(() => undefined)
 assert.deepEqual(s.accepted, ['/task e1'], 'the acceptance already running finishes')
 assert.equal(s.reports.length, 1); assert.match(s.reports[0], /\b1 acknowledged event/)
 const second = s.session(), restarted = s.adapter.receiveSession(second); await settle()
 assert.deepEqual(s.accepted, ['/task e1'], 'a stopped session leaves nothing to replay')
 second.controller.abort(); await restarted.catch(() => undefined); await s.adapter.dispose()
})

test('stop reports nothing when the queue is already drained', async t => {
 const s = setup(t)
 const session = s.session(), pending = s.adapter.receiveSession(session); await settle()
 s.sockets[0].emit('message', frame('e1', 0)); await settle()
 session.controller.abort(); await pending.catch(() => undefined)
 assert.deepEqual(s.accepted, ['/task e1']); assert.deepEqual(s.reports, [])
 await s.adapter.dispose()
})

test('a frame arriving during stop is neither ACKed nor queued', async t => {
 let release, entered; const inAccept = new Promise(resolve => { entered = resolve })
 const s = setup(t, { accept: async () => { entered(); await new Promise(resolve => { release = resolve }) } })
 const session = s.session(), pending = s.adapter.receiveSession(session); await settle()
 s.sockets[0].emit('message', frame('e1', 0)); await inAccept
 session.controller.abort()
 assert.equal(s.sockets[0].readyState, 3, 'abort terminates the socket synchronously')
 s.sockets[0].emit('message', frame('late', 1))
 release(); await pending.catch(() => undefined)
 assert.deepEqual(s.acks, ['e1'], 'Slack redelivers the un-ACKed frame')
 await s.adapter.dispose()
})

test('a frame still buffered on a closing socket is not ACKed', async t => {
 const s = setup(t)
 const session = s.session(), pending = s.adapter.receiveSession(session); await settle()
 s.sockets[0].readyState = 2
 s.sockets[0].emit('message', frame('late', 0)); await settle()
 assert.deepEqual(s.acks, []); assert.deepEqual(s.accepted, [])
 session.controller.abort(); await pending.catch(() => undefined); await s.adapter.dispose()
})

test('stop during the WebSocket handshake settles without waiting for its timeout', async t => {
 const s = setup(t, { socketOpens: false })
 const session = s.session(); let settled = false
 const pending = s.adapter.receiveSession(session).finally(() => { settled = true }).catch(error => error)
 await settle()
 assert.equal(s.sockets.length, 1); assert.equal(settled, false)
 session.controller.abort(); await settle()
 assert.equal(settled, true, 'no fake time passed, so only abort could settle it')
 assert.equal(s.sockets[0].readyState, 3)
 assert.equal((await pending).failure?.kind ?? (await pending).name, 'blocked')
 await s.adapter.dispose()
})
