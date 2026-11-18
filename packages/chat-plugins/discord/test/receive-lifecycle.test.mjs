import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { setImmediate as turn } from 'node:timers/promises'
import { createDiscordReceiver } from '../dist/adapter.js'

const bot = '10000000000000001', channel = '30000000000000003'
function fixture() {
  let socket
  const calls = []
  class Socket extends EventEmitter {
    send() {}
    terminate() { this.emit('close') }
    close() { this.emit('close') }
  }
  const adapter = createDiscordReceiver({ token: 'fixture' }, async (method, path, body) => {
    calls.push({ method, path, body })
    if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } }
    if (path.startsWith('/channels/')) return { id: channel, type: 1, recipients: [{ id: '40000000000000004' }] }
    return {}
  }, () => {
    socket = new Socket()
    queueMicrotask(() => {
      socket.emit('open')
      socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: bot, bot: true }, session_id: 'fixture' } })))
    })
    return socket
  }, async () => [{ address: '8.8.8.8', family: 4 }])
  return { adapter, calls, emit: data => socket.emit('message', Buffer.from(JSON.stringify(data))) }
}

test('idle receive returns an empty batch before the host deadline and removes abort listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { adapter } = fixture()
  const controller = new AbortController()
  const operation = { signal: controller.signal, assertActive: async () => {} }
  t.after(async () => { controller.abort(); await adapter.dispose() })
  let result
  const pending = adapter.receive(null, operation).then(batch => { result = batch }, () => {})
  await turn()
  t.mock.timers.tick(25000)
  await turn()
  assert.deepEqual(result, [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await pending
})

test('dispose settles an idle receive without reconnecting', async t => {
  const { adapter, calls } = fixture()
  const controller = new AbortController()
  t.after(() => controller.abort())
  let settled = false
  const pending = adapter.receive(null, { signal: controller.signal, assertActive: async () => {} }).then(() => { settled = true }, () => { settled = true })
  await turn()
  await adapter.dispose()
  await turn()
  assert.equal(settled, true)
  assert.equal(calls.filter(call => call.path === '/gateway/bot').length, 1)
  await pending
})

test('the published adapter exposes only the session receive model', async () => {
 const { createDiscordAdapter } = await import('../dist/adapter.js')
 const adapter = createDiscordAdapter({ token: 'fixture' }, async () => ({}))
 assert.equal('receive' in adapter, false); assert.equal(typeof adapter.receiveSession, 'function')
 await adapter.dispose()
})
