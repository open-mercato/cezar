// The one table for shared/adapter-support.ts, run against each plugin's built copy.
import test from 'node:test'
import assert from 'node:assert/strict'

class FakeAgent { closed = false; constructor(options) { this.options = options } async close() { this.closed = true } }
const address = last => ({ address: `8.8.8.${last}`, family: 4 })

export function adapterSupportTable(module) {
 test('a pooled agent is reused per validated address', () => {
  const pool = module.agentPool(FakeAgent), agentFor = target => { const lease = pool.lease(target); lease.release(); return lease.agent }
  assert.equal(agentFor(address(1)), agentFor(address(1)))
  assert.notEqual(agentFor(address(1)), agentFor(address(2)))
 })
 test('a pooled agent can dial only its validated address', () => {
  const { agent } = module.agentPool(FakeAgent).lease(address(1))
  agent.options.connect.lookup('elsewhere', {}, (_error, resolved) => assert.equal(resolved, '8.8.8.1'))
 })
 test('a delay waits, and an abort ends it at once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController(); let done = false
  const pending = module.abortableDelay(1000, controller.signal).then(() => { done = true })
  t.mock.timers.tick(999); await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false)
  controller.abort(); await pending
  assert.equal(done, true)
 })
 test('a delay on an aborted signal resolves without waiting', async () => {
  await module.abortableDelay(2 ** 40, AbortSignal.abort())
 })
 test('retry-after reads seconds, defaults to five and honours a cap', () => {
  assert.equal(module.retryAfterMs('2'), 2000)
  assert.equal(module.retryAfterMs(1.5), 1500)
  assert.equal(module.retryAfterMs(['3', '9']), 3000)
  for (const unusable of [undefined, null, '', 'soon', 0, -1, Infinity]) assert.equal(module.retryAfterMs(unusable), 5000, String(unusable))
  assert.equal(module.retryAfterMs(7200), 7200000)
  assert.equal(module.retryAfterMs(7200, 3600), 3600000)
 })
 test('the bounded map refreshes a re-remembered key and evicts the oldest', () => {
  const map = new Map()
  module.remember(map, 'a', 1, 2); module.remember(map, 'b', 2, 2); module.remember(map, 'a', 3, 2); module.remember(map, 'c', 4, 2)
  assert.deepEqual([...map], [['a', 3], ['c', 4]])
 })
 test('the pool is bounded and closes what it evicts', () => {
  const pool = module.agentPool(FakeAgent), agentFor = target => { const lease = pool.lease(target); lease.release(); return lease.agent }
  const first = agentFor(address(1))
  for (let last = 2; last <= 5; last++) agentFor(address(last))
  assert.equal(first.closed, true)
  assert.notEqual(agentFor(address(1)), first)
 })
 // Discord rotates five Cloudflare addresses against a pool of four.
 test('a hit refreshes its place, so the least recently used agent goes first', () => {
  const pool = module.agentPool(FakeAgent), agentFor = target => { const lease = pool.lease(target); lease.release(); return lease.agent }
  const first = agentFor(address(1)), second = agentFor(address(2))
  for (let last = 3; last <= 4; last++) agentFor(address(last))
  assert.equal(agentFor(address(1)), first)
  agentFor(address(5))
  assert.equal(first.closed, false, 'recently used')
  assert.equal(second.closed, true, 'least recently used')
 })
 test('an agent a request still holds is never closed under it', () => {
  const pool = module.agentPool(FakeAgent), held = pool.lease(address(1))
  for (let last = 2; last <= 6; last++) pool.lease(address(last)).release()
  assert.equal(held.agent.closed, false, 'evicted while held')
  held.release(); held.release()
  assert.equal(held.agent.closed, true, 'closed once released')
  assert.notEqual(pool.lease(address(1)).agent, held.agent)
 })
 // No idle socket survives dispose.
 test('close shuts idle agents now, held ones on release, and later leases dial afresh', () => {
  const pool = module.agentPool(FakeAgent), idle = pool.lease(address(1)), held = pool.lease(address(2))
  idle.release(); pool.close()
  assert.equal(idle.agent.closed, true)
  assert.equal(held.agent.closed, false)
  held.release()
  assert.equal(held.agent.closed, true)
  const again = pool.lease(address(1))
  assert.notEqual(again.agent, idle.agent); assert.equal(again.agent.closed, false)
 })
}
