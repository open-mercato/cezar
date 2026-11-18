import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as turn } from 'node:timers/promises'
import { createDiscordReceiver, discordRequest } from '../dist/adapter.js'

const bot = '10000000000000001', channel = '30000000000000003', user = '40000000000000004', guild = '60000000000000006'
const message = n => ({ op: 0, t: 'MESSAGE_CREATE', s: n, d: { id: String(70000000000000000n + BigInt(n)), channel_id: channel, author: { id: user, username: 'human' }, content: String(n), timestamp: '2026-11-01T00:00:00Z' } })
const interaction = (n, type = 2) => ({ op: 0, t: 'INTERACTION_CREATE', s: n, d: { id: String(80000000000000000n + BigInt(n)), application_id: bot, type, token: 'token-' + n, channel_id: channel, user: { id: user, username: 'human' }, data: { name: 'tasks', custom_id: 'confirm' }, message: { id: '50000000000000005', channel_id: channel, author: { id: bot, bot: true } } } })
function fixture(extra = async () => undefined) {
 const sockets = [], calls = []
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
 }, async () => [{ address: '8.8.8.8', family: 4 }])
 return { adapter, sockets, calls, async start(after = null) { const p = adapter.receive(after); await turn(); return { pending: p, socket: sockets.at(-1) } } }
}
test('burst deliveries have independent cursors, replay until checkpoint, and survive new sessions/restarts', async t => {
 t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
 const f = fixture(); t.after(() => f.adapter.dispose())
 const { pending, socket } = await f.start(900)
 socket.frame(message(2)); socket.frame(message(3))
 const first = await pending
 assert.equal(first[0].sequence, 901)
 assert.deepEqual(await f.adapter.receive(900), first)
 const second = await f.adapter.receive(901)
 assert.equal(second[0].sequence, 902); assert.equal(second[0].event.text, '3')
 socket.frame({ op: 9, d: false })
 const next = f.adapter.receive(902); await turn()
 t.mock.timers.tick(5000); await turn(); await turn()
 f.sockets.at(-1).frame(message(2))
 assert.equal((await next)[0].sequence, 903)
 const restarted = fixture(); t.after(() => restarted.adapter.dispose())
 const r = await restarted.start(903); r.socket.frame(message(2))
 assert.equal((await r.pending)[0].sequence, 904)
})
test('native command defers before slow channel lookup', async t => {
 let release
 const f = fixture(async (_m, path) => { if (path.startsWith('/channels/')) await new Promise(r => { release = r }) })
 t.after(() => f.adapter.dispose())
 const { pending, socket } = await f.start()
 socket.frame(interaction(2)); await turn()
 assert.equal(f.calls.find(c => c.path.includes('/callback'))?.body.type, 5)
 release(); await pending
})
test('membership uses production HTTP wrapper and retains operation authorization', async () => {
 for (const revoke of [false, true]) {
  const paths = []; let active = true
  const op = { signal: new AbortController().signal, assertActive: async () => { if (!active) throw Error('revoked') } }
  const request = discordRequest('fixture', {
   lookup: async () => [{ address: '8.8.8.8', family: 4 }],
   request: async url => {
    const path = new URL(url).pathname.replace('/api/v10', ''); paths.push(path)
    let data
    if (path.startsWith('/channels/')) data = { id: channel, guild_id: guild, type: 0, permission_overwrites: [] }
    else if (path.includes('/members/')) data = { user: { id: user }, roles: [] }
    else data = { id: guild, owner_id: user }
    if (revoke) active = false
    return { statusCode: 200, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })() }
   },
  })
  const adapter = createDiscordReceiver({ token: 'fixture' }, request)
  assert.equal(await adapter.isMember('discord:guild:' + guild + ':' + channel, user, op), revoke ? undefined : true)
  assert.equal(paths.length, revoke ? 1 : 4)
  await adapter.dispose()
 }
})
test('queue overflow reconnects from last retained dispatch and drains retained work first', async t => {
 t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
 const f = fixture(); t.after(() => f.adapter.dispose())
 const { pending, socket } = await f.start()
 for (let i = 2; i < 302; i++) socket.frame(message(i))
 assert.equal(socket.closed, true)
 let batch = await pending
 for (let i = 2; i < 258; i++) {
  assert.equal(batch[0].event.text, String(i))
  if (i < 257) batch = await f.adapter.receive(batch[0].sequence)
 }
 const next = f.adapter.receive(batch[0].sequence); await turn()
 t.mock.timers.tick(5000); await turn(); await turn()
 const resumed = f.sockets.at(-1)
 assert.equal(resumed.sent.find(x => x.op === 6).d.seq, 257)
 resumed.frame(message(258))
 assert.equal((await next)[0].event.text, '258')
})
test('failed conversion retries the retained dispatch without duplicate deferral', async t => {
 let reject = true
 const f = fixture(async (_m, path) => { if (path.startsWith('/channels/') && reject) throw Error('temporary lookup failure') })
 t.after(() => f.adapter.dispose())
 const { pending, socket } = await f.start()
 socket.frame(interaction(2))
 await assert.rejects(pending)
 reject = false
 const batch = await f.adapter.receive(null)
 assert.equal(batch[0].sequence, 1)
 assert.equal(f.calls.filter(c => c.path.includes('/callback')).length, 1)
})
test('real host bridge accepts burst and post-restart deliveries in order through the session', async t => {
 // Test-only host import exercises the actual session consumer, never a runtime dependency.
 const { tsImport } = await import('tsx/esm/api')
 const { ChatExtensionBridge } = await tsImport('../../../cezar/src/extensions/chat-bridge.ts', import.meta.url)
 const accepted = []
 const journal = { recover: async () => {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: '00000000-0000-4000-8000-000000000000', nextOffset: null }),
  duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {} }
 for (const values of [[2, 3], [2]]) {
  const f = fixture(async (_method, path) => path === '/users/@me' ? { id: bot, username: 'Cezar', bot: true } : undefined)
  let resolveDone
  const done = new Promise(r => { resolveDone = r })
  let count = 0
  const bridge = new ChatExtensionBridge(async (method, _input, options) => {
   assert.equal(method, 'receiveSession')
   const service = (name, input) => options.service(name, input)
   return f.adapter.receiveSession({ signal: options.signal, assertActive: async () => { assert.ok(options.valid()) },
    checkpoint: () => service('checkpoint'), accept: delivery => service('accept', delivery), health: value => service('health', value),
    openInteraction: () => { throw Error('unused') } })
  }, () => true, 'opaque')
  const connection = bridge.connect(journal, { assertCredentials: async () => {}, needed: () => true, onHealth: () => {}, process: async () => {},
   accept: async event => { accepted.push(event.text); if (++count === values.length) resolveDone() } })
  t.after(async () => { await connection.stop(); await f.adapter.dispose() })
  connection.start()
  for (let i = 0; i < 100 && !f.sockets[0]; i++) await turn()
  for (const value of values) f.sockets[0].frame(message(value))
  await Promise.race([done, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('bridge lost a delivery')), 3000); timer.unref() })])
  await turn()
  await connection.stop(); await f.adapter.dispose()
 }
 assert.deepEqual(accepted, ['2', '3', '2'])
})
test('membership cancellation during DNS prevents the next external request', async () => {
 const controller = new AbortController()
 let wireCalls = 0, lookups = 0
 const request = discordRequest('fixture', {
  lookup: async () => {
   if (++lookups === 2) controller.abort()
   return [{ address: '8.8.8.8', family: 4 }]
  },
  request: async () => {
   wireCalls++
   return { statusCode: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ id: channel, guild_id: guild, type: 0 })) })() }
  },
 })
 const adapter = createDiscordReceiver({ token: 'fixture' }, request)
 assert.equal(await adapter.isMember('discord:guild:' + guild + ':' + channel, user, { signal: controller.signal, assertActive: async () => {} }), undefined)
 assert.equal(lookups, 2)
 assert.equal(wireCalls, 1)
 await adapter.dispose()
})
test('queue byte bound reconnects before the count bound and preserves its prefix', async t => {
 t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
 const f = fixture(); t.after(() => f.adapter.dispose())
 const { pending, socket } = await f.start()
 for (let n = 2; n < 12; n++) {
  const frame = message(n); frame.d.unused = 'x'.repeat(600000); socket.frame(frame)
 }
 assert.equal(socket.closed, true)
 let batch = await pending
 for (let n = 2; n < 8; n++) {
  assert.equal(batch[0].event.text, String(n))
  if (n < 7) batch = await f.adapter.receive(batch[0].sequence)
 }
 const next = f.adapter.receive(batch[0].sequence); await turn()
 t.mock.timers.tick(5000); await turn(); await turn()
 const resumed = f.sockets.at(-1)
 assert.equal(resumed.sent.find(x => x.op === 6).d.seq, 7)
 resumed.frame(message(8))
 assert.equal((await next)[0].event.text, '8')
})

test('native task selection maps to status and ignores other native command names',async t=>{
 const f=fixture();t.after(()=>f.adapter.dispose())
 const {pending,socket}=await f.start()
 const selected=interaction(2);selected.d.data={name:'tasks',options:[{name:'task',value:'task-id'}]};socket.frame(selected)
 const event=(await pending)[0].event
 assert.equal(event.text,'/status task-id')
 assert.equal(event.messageId,selected.d.id,'Native message IDs must preserve canonical Discord snowflakes')
 const next=f.adapter.receive(1);const unknown=interaction(3);unknown.d.data={name:'cancel',options:[{name:'task',value:'task-id'}]};socket.frame(unknown)
 assert.equal((await next)[0].event,undefined)
})
test('native command finishes its private defer only after core accepts and honors stop',async()=>{
 for(const stop of [false,true]){
  const controller=new AbortController();let release,accepted
  const entered=new Promise(resolve=>accepted=resolve)
  const f=fixture(async(_method,path)=>path==='/users/@me'?{id:bot,bot:true}:undefined)
  const session={signal:controller.signal,assertActive:async()=>controller.signal.throwIfAborted(),health:async()=>{},openInteraction:async()=>{throw Error('unexpected query')},accept:async()=>{accepted();await new Promise(resolve=>release=resolve)}}
  const running=f.adapter.receiveSession(session);const settled=running.catch(error=>{if(!controller.signal.aborted)throw error})
  try{
   await turn();f.sockets.at(-1).frame(interaction(2));await entered
   assert.equal(f.calls.filter(call=>call.path.startsWith('/webhooks/')).length,0)
   if(stop)controller.abort();release();await turn();await turn()
   const replies=f.calls.filter(call=>call.path.startsWith('/webhooks/'))
   assert.equal(replies.length,stop?0:1)
   if(!stop)assert.deepEqual(replies[0].body,{content:'Command received. If you have access, Cezar replies in this chat.',allowed_mentions:{parse:[]}})
  }finally{controller.abort();release?.();await settled;await f.adapter.dispose()}
 }
})
