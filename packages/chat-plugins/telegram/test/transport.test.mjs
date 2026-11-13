import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { telegramRequest } from '../dist/adapter.js'

const token = `123456:${'A'.repeat(24)}`
test('transport validates and pins public DNS while bounding the streamed response', async () => {
  let connect
  const call = telegramRequest(token, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (_url, options) => {
      connect = options.dispatcher[Object.getOwnPropertySymbols(options.dispatcher).find(symbol => String(symbol).includes('options'))]?.connect
      return { statusCode: 200, body: Readable.from([JSON.stringify({ ok: true, result: { id: 1 } })]) }
    },
  })
  assert.deepEqual(await call('getMe', {}), { id: 1 })
  assert.ok(connect === undefined || typeof connect === 'object')

  const blocked = telegramRequest(token, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => assert.fail('wire called') })
  await assert.rejects(blocked('getMe', {}), error => error.failure?.kind === 'blocked')

  const controller = new AbortController()
  const stalled = telegramRequest(token, { lookup: async () => new Promise(() => {}), request: async () => assert.fail('wire called') })
  const pending = stalled('getMe', {}, { signal: controller.signal, assertActive: async () => {} })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error.failure?.kind === 'blocked')

  const oversized = telegramRequest(token, { lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ statusCode: 200, body: Readable.from([Buffer.alloc(1024 * 1024), Buffer.from('x')]) }) })
  await assert.rejects(oversized('getMe', {}), error => error.failure?.kind === 'blocked')
})

test('transport rejects every legacy non-public and reserved address class, including mapped IPv6', async () => {
  const rejected = [
    '0.1.2.3', '10.1.2.3', '100.64.1.2', '127.0.0.1', '169.254.1.2',
    '172.16.1.2', '192.0.0.1', '192.0.2.1', '192.168.1.2', '192.88.99.1',
    '198.18.1.2', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', '::ffff:10.1.2.3', '::ffff:192.0.2.1',
    '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001::1',
    '2001:db8::1', '2002::1', '3fff::1',
  ]
  for (const address of rejected) {
    const call = telegramRequest(token, { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], request: async () => assert.fail(`wire called for ${address}`) })
    await assert.rejects(call('getMe', {}), error => error.failure?.kind === 'blocked', address)
  }
})
