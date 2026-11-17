import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { createTelegramAdapter } from '../dist/adapter.js'

let server, base
const calls = []
const queued = []

before(async () => {
  server = createServer(async (request, response) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
    const method = request.url.slice(1)
    calls.push({ method, body })
    let result
    if (method === 'getMe') result = { id: 700001, username: 'cezar_fixture_bot' }
    else if (method === 'getChat') result = { id: Number(body.chat_id), type: Number(body.chat_id) < 0 ? 'supergroup' : 'private' }
    else if (method === 'getUpdates') result = queued.splice(0)
    else if (method === 'sendMessage') result = { message_id: 91, chat: { id: Number(body.chat_id) } }
    else if (method === 'getChatMember') result = { user: { id: body.user_id }, status: 'member' }
    else result = true
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { await new Promise(resolve => server.close(resolve)) })

const request = async (method, body, operation) => {
  await operation?.assertActive()
  const response = await fetch(`${base}/${method}`, { method: 'POST', body: JSON.stringify(body), signal: operation?.signal })
  return (await response.json()).result
}

// One receiveSession pass from `nextSequence`; the first health report means the batch landed.
async function pull(adapter, nextSequence) {
  const controller = new AbortController(), accepted = []
  await adapter.receiveSession({ signal: controller.signal, assertActive: async () => {}, checkpoint: async () => ({ epoch: 'e', nextSequence }),
    accept: async delivery => { accepted.push(delivery) }, health: async () => controller.abort() })
  return accepted
}
test('real adapter talks to a local Telegram API simulator and normalizes receive rows', async () => {
  const adapter = createTelegramAdapter(request)
  assert.equal('receive' in adapter, false)
  assert.deepEqual(await adapter.identify(), { id: '700001', username: 'cezar_fixture_bot', discoveryUrl: 'https://t.me/cezar_fixture_bot' })
  queued.push(
    { update_id: 10, message: { message_id: 20, date: 1800000000, chat: { id: -30, type: 'supergroup', title: 'Team' }, from: { id: 40, is_bot: false, first_name: 'Ada' }, text: '/tasks@cezar_fixture_bot', entities: [{ type: 'bot_command', offset: 0, length: 24 }] } },
    { update_id: 11, edited_message: { ignored: true } },
    { update_id: 12, callback_query: { id: 'callback-12', from: { id: 40, is_bot: false, first_name: 'Ada' }, data: 'confirm', message: { message_id: 21, chat: { id: -30, type: 'supergroup' } } } },
  )
  const batch = await pull(adapter, null)
  assert.equal(batch.length, 3)
  assert.deepEqual(batch[0].event, { kind: 'message', id: 'update:10', messageId: '20', chat: { id: '-30', kind: 'group' }, title: 'Team', user: { id: '40', label: 'Ada' }, at: 1800000000000, text: '/tasks@cezar_fixture_bot', addressed: true, pairingEligible: true, command: { kind: 'command', name: 'tasks', args: '' } })
  assert.deepEqual(batch[1], { kind: 'ordered', epoch: 'e', sequence: 11 })
  assert.equal(batch[2].event.kind, 'button')
  assert.equal(calls.find(call => call.method === 'getUpdates').body.offset, undefined)

  queued.push({ update_id: 13, my_chat_member: { chat: { id: -30, type: 'supergroup' }, new_chat_member: { status: 'kicked' } } })
  const next = await pull(adapter, 13)
  assert.deepEqual(next[0].event, { kind: 'membership', id: 'update:13', chat: { id: '-30', kind: 'group' }, reason: 'removed' })
  assert.equal(calls.filter(call => call.method === 'getUpdates').at(-1).body.offset, 13)
})

test('send, membership and operation fencing stay on the public adapter surface', async () => {
  const adapter = createTelegramAdapter(request)
  const active = { signal: new AbortController().signal, assertActive: async () => {} }
  assert.deepEqual(await adapter.send('-30', { text: 'hello', buttons: [[{ text: 'Confirm', data: 'yes' }]] }, active), { messageId: '91', chatId: '-30' })
  assert.equal(await adapter.isMember('-30', '40', active), true)
  const send = calls.findLast(call => call.method === 'sendMessage')
  assert.deepEqual(send.body.reply_markup.inline_keyboard, [[{ text: 'Confirm', callback_data: 'yes' }]])
})
