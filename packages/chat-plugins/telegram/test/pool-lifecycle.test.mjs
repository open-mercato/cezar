// The adapter's pooled agents close at dispose.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createTelegramAdapter, telegramRequest } from '../dist/adapter.js'

test('dispose closes the pooled agents', async t => {
 t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 })
 const dispatchers = []
 const request = telegramRequest('12345:' + 'a'.repeat(30), { lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: async (_url, options) => { dispatchers.push(options.dispatcher); return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('{"ok":true,"result":{"id":12345,"is_bot":true,"username":"bot"}}')]) } } })
 const adapter = createTelegramAdapter(request)
 await adapter.identify()
 assert.equal(dispatchers[0].closed, false)
 await adapter.dispose()
 assert.equal(dispatchers[0].closed, true)
})
