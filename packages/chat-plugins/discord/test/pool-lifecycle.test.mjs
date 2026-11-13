// Pooled agents close at dispose, and never under a request.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createDiscordAdapter, discordRequest } from '../dist/adapter.js'

const ok = body => ({ statusCode: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify(body))]) })
const me = { id: '10000000000000001', username: 'bot', bot: true }

test('dispose closes the pooled agents', async t => {
 t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 })
 const dispatchers = []
 const request = discordRequest('token', { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async (_url, options) => { dispatchers.push(options.dispatcher); return ok(me) } })
 const adapter = createDiscordAdapter({ token: 'fixture' }, request, () => { throw Error('unused') }, async () => [{ address: '93.184.216.34', family: 4 }], async () => {})
 await adapter.identify()
 assert.equal(dispatchers[0].closed, false)
 await adapter.dispose()
 assert.equal(dispatchers[0].closed, true)
})

// Discord resolves to five Cloudflare addresses; the pool keeps four.
test('a POST holding its agent reaches the server even when rotation evicts that agent', async t => {
 t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 })
 let next = 0, reached = 0
 const request = discordRequest('token', {
  lookup: async () => [{ address: `93.184.216.${100 + next++}`, family: 4 }],
  // undici refuses a request on a closed agent without sending it.
  request: async (_url, options) => { if (options.dispatcher.closed) throw new Error('ClientClosedError'); reached++; return ok({ id: '90000000000000009' }) },
 })
 const active = { signal: new AbortController().signal, assertActive: async () => {} }
 let release, entered; const inside = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
 let checks = 0
 // The second check runs after the agent is leased and before the request leaves.
 const slow = { signal: active.signal, assertActive: async () => { if (++checks === 2) { entered(); await held } } }
 const post = request('POST', '/channels/30000000000000003/messages', { content: 'x' }, slow).then(() => 'sent', error => error.failure?.kind)
 await inside
 for (let i = 0; i < 4; i++) await request('GET', '/users/@me', undefined, active)
 const before = reached
 release()
 assert.equal(await post, 'sent')
 assert.equal(reached, before + 1)
})
