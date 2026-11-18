// The one table for shared/pinned-request.ts, run against each plugin's built copy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const fail = kind => Object.assign(new Error(kind), { kind })
const nonPublic = ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
 '::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '2001::1', '2001:db8::1', '2002::1', '3fff::1', '100::1', 'fe80::1%eth0', 'not-an-ip', '']
const publicOnes = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '[2606:4700:4700::1111]', '2606:4700:4700::1111', '::ffff:8.8.8.8']

export function pinnedRequestTable(module) {
 for (const address of nonPublic) test(`refuses ${address || 'an empty address'}`, () => assert.equal(module.publicAddress(address), false))
 for (const address of publicOnes) test(`accepts ${address}`, () => assert.equal(module.publicAddress(address), true))
 test('one non-public record refuses the whole host', () => {
  assert.throws(() => module.publicTarget([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], fail), { kind: 'blocked' })
  assert.throws(() => module.publicTarget([], fail), { kind: 'blocked' })
  assert.throws(() => module.publicTarget([{ address: '8.8.8.8', family: 6 }], fail), { kind: 'blocked' })
 })
 test('a pinned dial reaches only the validated address', async () => {
  const target = await module.pinPublicAddress('host', async () => [{ address: '8.8.8.8', family: 4 }], new AbortController().signal, 1000, fail)
  const { lookup, rejectUnauthorized, autoSelectFamily } = module.pinnedConnect(target)
  assert.equal(rejectUnauthorized, true); assert.equal(autoSelectFamily, false)
  lookup('other', { all: true }, (_error, addresses) => assert.deepEqual(addresses, [target]))
  lookup('other', {}, (_error, address, family) => { assert.equal(address, '8.8.8.8'); assert.equal(family, 4) })
 })
 test('an aborted lookup is blocked and cancels the resolver', async () => {
  const controller = new AbortController(); let seen
  const pending = module.pinPublicAddress('host', (_host, signal) => { seen = signal; return new Promise(() => {}) }, controller.signal, 60000, fail)
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  await assert.rejects(pending, { kind: 'blocked' }); assert.equal(seen.aborted, true)
 })
 test('a lookup past its deadline is transient', async () => {
  await assert.rejects(module.pinPublicAddress('host', () => new Promise(() => {}), new AbortController().signal, 1, fail), { kind: 'transient' })
 })
 test('a response body is capped while streaming', async () => {
  assert.equal((await module.readCapped(Readable.from([Buffer.from('ok')]), fail)).toString(), 'ok')
  await assert.rejects(module.readCapped(Readable.from([Buffer.alloc(module.MAX_RESPONSE_BYTES), Buffer.from('x')]), fail), { kind: 'blocked' })
 })
}
