// A queue head that cannot resolve must not keep the bot deaf.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { createSlackAdapter } from '../dist/adapter.js'

const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)) }
const slash = (id, channel) => Buffer.from(JSON.stringify({ envelope_id: id, type: 'slash_commands', payload: { team_id: 'T1', user_id: 'U2', command: '/cezar', channel_id: channel, text: `status ${id}`, trigger_id: `trig-${id}` } }))
const message = (id, channel) => Buffer.from(JSON.stringify({ envelope_id: id, type: 'events_api', payload: { team_id: 'T1', authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', channel, user: 'U2', ts: `${Math.floor(Date.now() / 1000)}.000001`, text: `<@U1> /task ${id}` } } }))

function setup(t, failure) {
 t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 })
 const state = { accepted: [], sockets: [], reports: [], lookups: 0 }
 class Socket extends EventEmitter {
  readyState = 1
  send() {}
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close') }
  ping() {}
 }
 const wire = async (method, body) => {
  if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' }
  if (method === 'apps.connections.open') return { url: 'wss://slack.com/socket' }
  if (method === 'conversations.info') {
   if (body.channel === 'CPOISON') { state.lookups++; throw new ExtensionChatError({ kind: failure }) }
   return { channel: { id: body.channel, is_im: false, is_member: true } }
  }
  throw Error(method)
 }
 state.adapter = createSlackAdapter({ appToken: 'xapp-1234567890', botToken: 'xoxb-1234567890' }, wire, {
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  socket: () => { const socket = new Socket(); state.sockets.push(socket); queueMicrotask(() => socket.emit('open')); return socket },
  report: line => state.reports.push(line),
 })
 state.run = async () => {
  const controller = new AbortController()
  const session = { signal: controller.signal, assertActive: async () => controller.signal.throwIfAborted(), health: async () => {},
   accept: async delivery => { state.accepted.push(delivery.event.chat.id) } }
  const run = { controller, settled: false }
  run.pending = state.adapter.receiveSession(session).then(() => 'ended', error => error.failure?.kind ?? error.name).finally(() => { run.settled = true })
  await settle()
  return run
 }
 return state
}

test('a slash-command head that keeps failing ages out after 15 minutes', async t => {
 const s = setup(t, 'transient')
 const first = await s.run()
 s.sockets[0].emit('message', slash('poison', 'CPOISON')); s.sockets[0].emit('message', slash('good', 'CGOOD'))
 assert.equal(await first.pending, 'transient')
 t.mock.timers.tick(10 * 60_000)
 assert.equal(await (await s.run()).pending, 'transient', 'still young: retried')
 t.mock.timers.tick(6 * 60_000)
 const third = await s.run()
 assert.equal(s.reports.length, 2, 'both expired heads are dropped and counted')
 assert.match(s.reports[1], /dropped an acknowledged event .*\(2 so far\)/)
 for (const line of s.reports) assert.doesNotMatch(line, /poison|good|CPOISON|CGOOD|U2|T1|U1|trig/)
 assert.equal(s.sockets.length, 2, 'the socket is open again')
 s.sockets[1].emit('message', slash('fresh', 'CFRESH')); await settle()
 assert.deepEqual(s.accepted, ['group:T1:U1:CFRESH'], 'and the bot hears new events')
 third.controller.abort(); await third.pending; await s.adapter.dispose()
})

test('a transient head is dropped after a bounded number of attempts', async t => {
 const failure = 'transient'
 const s = setup(t, failure)
 const first = await s.run()
 s.sockets[0].emit('message', message('poison', 'CPOISON')); s.sockets[0].emit('message', message('good', 'CGOOD'))
 const ends = [await first.pending]
 for (let i = 0; i < 2; i++) { t.mock.timers.tick(1000); ends.push(await (await s.run()).pending) }
 assert.deepEqual(ends, [failure, failure, failure])
 t.mock.timers.tick(1000)
 const fourth = await s.run()
 assert.equal(s.lookups, 3)
 assert.deepEqual(s.accepted, ['group:T1:U1:CGOOD'])
 assert.equal(s.sockets.length, 2)
 assert.equal(fourth.settled, false, 'a later session keeps running')
 fourth.controller.abort(); await fourth.pending
 assert.equal(s.reports.length, 1)
 await s.adapter.dispose()
})

for (const failure of ['blocked', 'conflict']) test(`a ${failure} lookup (missing_scope) drops only that event and the session keeps running`, async t => {
 const s = setup(t, failure)
 const first = await s.run()
 s.sockets[0].emit('message', message('poison', 'CPOISON')); s.sockets[0].emit('message', message('good', 'CGOOD')); await settle()
 assert.equal(first.settled, false)
 assert.equal(s.lookups, 1)
 assert.deepEqual(s.accepted, ['group:T1:U1:CGOOD'])
 assert.equal(s.reports.length, 1)
 first.controller.abort(); await first.pending; await s.adapter.dispose()
})
