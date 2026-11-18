// The adapter's pooled agents close at dispose.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createSlackAdapter, slackRequest } from '../dist/adapter.js'

test('dispose closes the pooled agents', async t => {
 t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 })
 const credentials = { appToken: 'xapp-1234567890', botToken: 'xoxb-1234567890' }, dispatchers = []
 const request = slackRequest(credentials, { lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: async (_url, options) => { dispatchers.push(options.dispatcher); return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('{"ok":true,"team_id":"T1","user_id":"U1"}')]) } } })
 const adapter = createSlackAdapter(credentials, request, { lookup: async () => [{ address: '93.184.216.34', family: 4 }], socket: () => { throw Error('unused') } })
 await adapter.identify()
 assert.equal(dispatchers[0].closed, false)
 await adapter.dispose()
 assert.equal(dispatchers[0].closed, true)
})
