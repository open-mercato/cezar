import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as turn } from 'node:timers/promises'
import { createDiscordReceiver, discordRequest } from '../dist/adapter.js'

const bot = '10000000000000001', channel = '30000000000000003', user = '40000000000000004', guild = '60000000000000006'
const message = n => ({ op: 0, t: 'MESSAGE_CREATE', s: n, d: { id: String(70000000000000000n + BigInt(n)), channel_id: channel, author: { id: user, username: 'human' }, content: String(n), timestamp: '2026-11-01T00:00:00Z' } })
const interaction = (n, type = 2) => ({ op: 0, t: 'INTERACTION_CREATE', s: n, d: { id: String(80000000000000000n + BigInt(n)), application_id: bot, type, token: 'token-' + n, channel_id: channel, user: { id: user, username: 'human' }, data: { name: 'tasks', custom_id: 'confirm' }, message: { id: '50000000000000005', channel_id: channel, author: { id: bot, bot: true } } } })
function fixture(extra = async () => undefined, report = async () => {}) {
 const sockets = [], calls = [], failures = []
 class Socket extends EventEmitter {
  sent = []; closed = false
  send(value) { this.sent.push(JSON.parse(value)) }
  terminate() { this.closed = true; this.emit('close') }
  close() { this.terminate() }
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))) }
 }
 const adapter = createDiscordReceiver({ token: 'fixture' }, async (method, path, body, op) => {
  calls.push({ method, path, body })
  const result = await extra(method, path, body, op)
  if (result !== undefined) return result
  if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg/', shards: 1, session_start_limit: { remaining: 1000 } }
  if (path.startsWith('/channels/')) return { id: channel, type: 1, recipients: [{ id: user }] }
  return {}
 }, () => {
  const s = new Socket(); sockets.push(s)
  queueMicrotask(() => {
   s.frame({ op: 10, d: { heartbeat_interval: 120000 } })
   const resume = s.sent.find(x => x.op === 6)
   s.frame(resume ? { op: 0, t: 'RESUMED', s: resume.d.seq } : { op: 0, t: 'READY', s: 1, d: { user: { id: bot, bot: true }, session_id: 'session-' + sockets.length } })
  })
  return s
 }, async () => [{ address: '8.8.8.8', family: 4 }], async line => { await report(line); failures.push(line) })
 return { adapter, sockets, calls, failures, async start(after = null) { const p = adapter.receive(after); await turn(); return { pending: p, socket: sockets.at(-1) } } }
}

import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
test('permanent gone head is visibly terminal and replayable before healthy traffic', async t => {
 let tries=0
 const f=fixture(async (_m,path) => { if(path.includes('/channels/90000000000000009')) { tries++; throw new ExtensionChatError({kind:'gone'}) } }); t.after(()=>f.adapter.dispose())
 const {pending,socket}=await f.start()
 const bad=message(2); bad.d.channel_id='90000000000000009'
 socket.frame(bad); socket.frame(message(3))
 const terminal = await pending
 assert.deepEqual(terminal, [{sequence: 1}])
 assert.deepEqual(await f.adapter.receive(null), terminal)
 assert.equal(tries,1)
 assert.equal(f.failures.length,1)
 assert.match(f.failures[0], /70000000000000002.*gone.*not processed/)
 assert.equal((await f.adapter.receive(1))[0].event.text, '3')
})
test('abort during conversion retains row and retry succeeds',async t=>{
 let release, slow=true; const controller=new AbortController()
 const f=fixture(async (_m,path,_b,op)=>{if(path.startsWith('/channels/')&&slow){await new Promise(r=>release=r);op.signal.throwIfAborted()}});t.after(()=>f.adapter.dispose())
 const pending=f.adapter.receive(null,{signal:controller.signal,assertActive:async()=>{}});await turn();f.sockets[0].frame(message(2));await turn();controller.abort();release();await assert.rejects(pending);slow=false
 assert.equal((await f.adapter.receive(null))[0].event.text,'2')
})
test('failed terminal reporting retains the head and cursor until a visible report succeeds', async t => {
 let unavailable = true, lookups = 0
 const f = fixture(async (_m, path) => {
  if (path.includes('/channels/90000000000000009')) {
   lookups++
   throw new ExtensionChatError({kind: 'gone'})
  }
 }, async () => { if (unavailable) throw Error('logger unavailable') })
 t.after(() => f.adapter.dispose())
 const {pending, socket} = await f.start(80)
 const bad = message(2); bad.d.channel_id = '90000000000000009'
 socket.frame(bad); socket.frame(message(3))
 await assert.rejects(pending, e => e.failure.kind === 'transient')
 await assert.rejects(f.adapter.receive(80), e => e.failure.kind === 'transient')
 assert.equal(f.failures.length, 0)
 unavailable = false
 assert.deepEqual(await f.adapter.receive(80), [{sequence: 81}])
 assert.equal(lookups, 1)
 assert.equal(f.failures.length, 1)
 assert.deepEqual(await f.adapter.receive(80), [{sequence: 81}])
 assert.equal(f.failures.length, 1)
 const healthy = await f.adapter.receive(81)
 assert.equal(healthy[0].sequence, 82)
 assert.equal(healthy[0].event.text, '3')
})

test('authorization and ownership failures never become terminal checkpoint rows', async t => {
 for (const kind of ['auth', 'conflict']) {
  let failing = true
  const f = fixture(async (_m, path) => {
   if (path.startsWith('/channels/') && failing) throw new ExtensionChatError({kind})
  })
  t.after(() => f.adapter.dispose())
  const {pending, socket} = await f.start(20)
  socket.frame(message(2)); socket.frame(message(3))
  await assert.rejects(pending, e => e.failure.kind === kind)
  assert.equal(f.failures.length, 0)
  failing = false
  const retried = await f.adapter.receive(20)
  assert.equal(retried[0].sequence, 21)
  assert.equal(retried[0].event.text, '2')
  assert.equal((await f.adapter.receive(21))[0].event.text, '3')
 }
})

test('gone response racing operation abort retains the action instead of reporting terminal', async t => {
 let release, failing = true
 const controller = new AbortController()
 const f = fixture(async (_m, path) => {
  if (path.startsWith('/channels/') && failing) {
   await new Promise(r => { release = r })
   throw new ExtensionChatError({kind: 'gone'})
  }
 })
 t.after(() => f.adapter.dispose())
 const pending = f.adapter.receive(null, {signal: controller.signal, assertActive: async () => {}})
 await turn(); f.sockets[0].frame(message(2)); await turn()
 controller.abort(); release()
 await assert.rejects(pending)
 assert.equal(f.failures.length, 0)
 failing = false
 const retried = await f.adapter.receive(null)
 assert.equal(retried[0].sequence, 1)
 assert.equal(retried[0].event.text, '2')
})
