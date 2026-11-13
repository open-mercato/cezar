import assert from 'node:assert/strict'
import { test } from 'node:test'
import {chatDeliverySchema} from '@open-mercato/cezar-extension-sdk/chat'
import { createSlackReceiver, slackRequest } from '../dist/adapter.js'

const creds = { appToken: 'xapp-' + 'A'.repeat(20), botToken: 'xoxb-' + 'B'.repeat(20) }
const op = { signal: new AbortController().signal, assertActive: async () => {} }
const rows = [
  { envelope_id: 'e1', type: 'events_api', event_id: 'ev1', payload: { team_id: 'T1', authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', channel: 'C1', user: 'U2', ts: '1800000000.000001', channel_type: 'channel', text: '<@U1> hello' } } },
]
test('Slack adapter uses mocked API and normalizes a Socket Mode message', async () => {
  const calls = []
  const request = async (method, body) => {
    calls.push([method, body])
    if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'U1', user: 'cezar' }
    if (method === 'apps.connections.open') return { ok: true, url: 'wss://slack.com/socket' }
    if (method === 'conversations.info') return { ok: true, channel: { id: 'C1', is_im: false, is_member: true } }
    if (method === 'chat.postMessage') return { ok: true, channel: 'C1', ts: '1800000001.000001' }
    if (method === 'conversations.members') return { ok: true, members: ['U2'] }
    return { ok: true }
  }
  const adapter = createSlackReceiver(creds, request)
  assert.deepEqual(await adapter.identify(op), { id: 'T1:U1', username: 'T1:U1', discoveryUrl: 'https://api.slack.com/apps' })
  assert.deepEqual(await adapter.send('group:T1:U1:C1', { text: 'hello' }, op), { chatId: 'group:T1:U1:C1', messageId: '1800000001.000001' })
  assert.equal(await adapter.isMember('group:T1:U1:C1', 'U2', op), true)
  assert.ok(calls.some(([method]) => method === 'chat.postMessage'))
  await adapter.dispose()
})

test('credentials and destination identity fail closed', () => {
  assert.throws(() => createSlackReceiver({ appToken: 'bad', botToken: 'bad' }), /Chat transport: auth/)
})

test('Slack API transport rejects private DNS answers before dialing', async () => {
  let dialed = false
  const request = slackRequest(creds, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => { dialed = true; throw new Error('must not dial') } })
  await assert.rejects(request('auth.test', {}, op), /Chat transport: blocked/)
  assert.equal(dialed, false)
})

test('cancels a hung Slack REST DNS lookup when the operation aborts', async () => {
  let lookupSignal
  const request = slackRequest(creds, { lookup: async (_host, signal) => { lookupSignal = signal; await new Promise(() => {}) } })
  const controller = new AbortController()
  const pending = request('auth.test', {}, { signal: controller.signal, assertActive: async () => {} })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('lookup did not cancel')), 250))]), /blocked/)
  assert.equal(lookupSignal?.aborted, true)
})

test('Slack outbound identity fences, renders buttons, and paginates members', async () => {
  const calls = []
  const request = async (method, body) => {
    calls.push([method, body])
    if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'U1', user: 'cezar' }
    if (method === 'conversations.info') return { ok: true, channel: { id: 'C1', is_im: false, is_member: true } }
    if (method === 'chat.postMessage') return { ok: true, channel: 'C1', ts: '1800000001.000001' }
    if (method === 'chat.update') return { ok: true, channel: 'C1' }
    if (method === 'conversations.members') return body.cursor ? { ok: true, members: ['U2'], response_metadata: { next_cursor: '' } } : { ok: true, members: [], response_metadata: { next_cursor: 'page-2' } }
    return { ok: true }
  }
  const adapter = createSlackReceiver(creds, request)
  await adapter.identify(op)
  const receipt = await adapter.send('group:T1:U1:C1', { text: 'choose', buttons: [[{ text: 'Go', data: 'go' }]] }, op)
  assert.equal(calls.find(([method]) => method === 'chat.postMessage')[1].blocks.find(block => block.type === 'actions').elements[0].action_id, 'cezar_0')
  await adapter.clearButtons(receipt, op)
  assert.equal(await adapter.isMember('group:T1:U1:C1', 'U2', op), true)
  await assert.rejects(adapter.send('group:T9:U1:C1', { text: 'nope' }, op), /blocked/)
  await assert.rejects(adapter.clearButtons({ chatId: 'group:T1:U9:C1', messageId: receipt.messageId }, op), /blocked/)
})

test('Slack receive envelopes require the authenticated bot authorization', async () => {
  const request = async (method) => {
    if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'U1', user: 'cezar' }
    if (method === 'apps.connections.open') return { ok: true, url: 'wss://slack.com/socket' }
    return { ok: true, channel: { id: 'C1', is_im: false, is_member: true } }
  }
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    handlers = new Map()
    on(name, fn) { this.handlers.set(name, fn); return this }
    once(name, fn) { this.handlers.set(name, fn); return this }
    send() {}
    terminate() { this.handlers.get('close')?.() }
  }
  const adapter = createSlackReceiver(creds, request, { lookup: async () => [{ address: '93.184.216.34', family: 4 }], socket: (_url) => { const s = new FakeSocket(); queueMicrotask(() => s.handlers.get('open')?.()); return s } })
  const controller = new AbortController(); const cancel = { signal: controller.signal, assertActive: async () => {} }
  await adapter.identify(cancel)
  const pending = adapter.receive(null, cancel); setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, /blocked/)
  await adapter.dispose()
})

test('Slack normalizes native slash commands and button interactions', async () => {
  const request = async (method, body) => {
    if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'U1', user: 'cezar' }
    if (method === 'apps.connections.open') return { ok: true, url: 'wss://slack.com/socket' }
    if (method === 'conversations.info') return { ok: true, channel: { id: body.channel, is_im: false, is_member: true } }
    return { ok: true }
  }
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    handlers = new Map()
    on(name, fn) { this.handlers.set(name, fn); return this }
    once(name, fn) { this.handlers.set(name, fn); return this }
    send() {}
    terminate() { this.handlers.get('close')?.() }
    emit(name, value) { this.handlers.get(name)?.(value) }
  }
  let socket
  const adapter = createSlackReceiver(creds, request, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    socket: () => { socket = new FakeSocket(); queueMicrotask(() => socket.emit('open')); return socket },
  })
  await adapter.identify(op)
  const stamp = `${Math.floor(Date.now() / 1000)}.000001`
  const slash = adapter.receive(null, op)
  await new Promise(resolve => setImmediate(resolve))
  socket.emit('message', Buffer.from(JSON.stringify({ envelope_id: 'slash', type: 'slash_commands', payload: { team_id: 'T1', user_id: 'U2', channel_id: 'C1', command: '/cezar', text: 'tasks', trigger_id: '1800000000.000001' } })))
  assert.equal((await slash)[0].event.text, '/tasks')
  const button = adapter.receive(1, op)
  await new Promise(resolve => setImmediate(resolve))
  socket.emit('message', Buffer.from(JSON.stringify({ envelope_id: 'button', type: 'interactive', payload: { type: 'block_actions', team: { id: 'T1' }, message: { user: 'U1' }, user: { id: 'U2' }, container: { channel_id: 'C1', message_ts: stamp }, actions: [{ action_id: 'cezar_0', value: 'approve', action_ts: stamp }] } })))
  assert.deepEqual((await button)[0].event, { kind: 'button', id: `button:C1:U2:${stamp}`, chat: { id: 'group:T1:U1:C1', kind: 'group' }, user: { id: 'U2', label: 'U2' }, receipt: { chatId: 'group:T1:U1:C1', messageId: stamp }, data: 'approve' })
  const message = adapter.receive(2, op)
  await new Promise(resolve => setImmediate(resolve))
  socket.emit('message', Buffer.from(JSON.stringify({envelope_id:'message',type:'events_api',payload:{team_id:'T1',authorizations:[{user_id:'U1',is_bot:true}],event:{type:'message',channel:'C1',user:'U2',ts:stamp,text:'<@U1> hello'}}})))
  const event=(await message)[0].event
  assert.equal(event.at,Math.floor(Number(stamp)*1000))
  assert.equal(chatDeliverySchema.safeParse({kind:'event',event}).success,true)
  await adapter.dispose()
})
test('a fresh Slack adapter identifies before sending without a preceding receive session',async()=>{
 const calls=[]
 const adapter=createSlackReceiver(creds,async(method,body)=>{
  calls.push(method)
  if(method==='auth.test')return {ok:true,team_id:'T1',user_id:'U1'}
  if(method==='chat.postMessage')return {ok:true,channel:body.channel,ts:'1800000000.000009'}
  throw Error('Unexpected method '+method)
 })
 try{
  assert.deepEqual(await adapter.send('private:T1:U1:D1',{text:'hello'},op),{chatId:'private:T1:U1:D1',messageId:'1800000000.000009'})
  assert.deepEqual(calls,['auth.test','chat.postMessage'])
 }finally{await adapter.dispose()}
})
