import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { createTelegramAdapter, telegramRequest } from '../dist/adapter.js'

const token = `123456:${'A'.repeat(24)}`
const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
const epoch = '11111111-1111-4111-8111-111111111111'
const reply = (statusCode, value) => ({ statusCode, body: Readable.from([Buffer.from(JSON.stringify(value))]) })
const active = { signal: new AbortController().signal, assertActive: async () => {} }

/** A session whose loop stops at the `stopAfter`-th health report. */
function session(stopAfter = 1) {
  const controller = new AbortController(), accepted = [], states = []
  return { accepted, states, controller, signal: controller.signal, assertActive: async () => {}, checkpoint: async () => ({ epoch, nextSequence: null }),
    accept: async delivery => { accepted.push(delivery); return { disposition: 'accepted', checkpoint: { epoch, nextSequence: delivery.sequence + 1 } } },
    health: async value => { states.push(value.state); if (states.filter(state => state === 'polling').length >= stopAfter) controller.abort() } }
}
const wire = handlers => async (method, body, operation) => {
  const handler = handlers[method]
  if (handler) return handler(body, operation)
  if (method === 'getMe') return { id: 7, username: 'fixture_bot' }
  if (method === 'getUpdates') return []
  return true
}

test('membership follows the Bot API status rules and keeps unknown evidence unknown', async () => {
  const member = result => createTelegramAdapter(wire({ getChatMember: async () => result })).isMember('-30', '40', active)
  const user = { id: 40 }
  assert.equal(await member({ user, status: 'restricted', is_member: false }), false)
  assert.equal(await member({ user, status: 'restricted', is_member: true }), true)
  assert.equal(await member({ user, status: 'restricted' }), false)
  assert.equal(await member({ user, status: 'member' }), true)
  assert.equal(await member({ user, status: 'left' }), false)
  assert.equal(await member({ user: { id: 41 }, status: 'member' }), undefined, 'another user answers nothing')
  assert.equal(await member({ user, status: 'owner?' }), undefined, 'unknown status is unknown')
  assert.equal(await member(null), undefined)
})
test('membership reads only HTTP 400 as a denial', async () => {
  const answer = async status => {
    const request = telegramRequest(token, { lookup, request: async () => reply(status, { ok: false }) })
    return createTelegramAdapter(request).isMember('-30', '40', active)
  }
  assert.equal(await answer(400), false)
  for (const status of [401, 403, 404, 429, 500]) assert.equal(await answer(status), undefined, String(status))
  const adapter = createTelegramAdapter(async () => { throw new ExtensionChatError({ kind: 'transient' }) })
  assert.equal(await adapter.isMember('-30', '40', active), undefined)
})
test('a receive session registers the bot menu the host routes', async () => {
  const { tsImport } = await import('tsx/esm/api')
  const { CHAT_COMMANDS } = await tsImport('../../../cezar/src/chat/events.ts', import.meta.url)
  const calls = []
  await createTelegramAdapter(wire({ setMyCommands: async body => { calls.push(body); return true } })).receiveSession(session())
  assert.deepEqual(calls, [{ commands: CHAT_COMMANDS }])
})
test('a failed menu leaves polling running and is retried by the next session', async () => {
  let attempts = 0, polls = 0
  const adapter = createTelegramAdapter(wire({ setMyCommands: async () => { if (++attempts === 1) throw new ExtensionChatError({ kind: 'transient' }); return true }, getUpdates: async () => { polls++; return [] } }))
  await adapter.receiveSession(session()); await adapter.receiveSession(session()); await adapter.receiveSession(session())
  assert.equal(polls, 3)
  assert.equal(attempts, 2, 'registered once it succeeds')
})
test('stopping a session cancels a pending menu and waits for it to settle', async () => {
  let menuSignal, release, stopped = false
  const settled = new Promise(resolve => { release = resolve })
  const fixture = session()
  const running = createTelegramAdapter(wire({ setMyCommands: async (_body, operation) => { menuSignal = operation.signal; await settled; return true } })).receiveSession(fixture).then(() => { stopped = true })
  await turn(); await turn()
  assert.equal(menuSignal?.aborted, true, 'polling proceeded past the pending menu and stop cancelled it')
  assert.equal(stopped, false, 'ownership stays held until the menu settles')
  release(); await running
  assert.equal(stopped, true)
})
test('the menu has no authority once its operation is revoked', async () => {
  const fixture = session()
  let wired = 0
  const request = telegramRequest(token, { lookup, request: async () => { wired++; return reply(200, { ok: true, result: true }) } })
  await assert.rejects(request('setMyCommands', {}, { signal: fixture.signal, assertActive: async () => { throw new Error('revoked') } }))
  assert.equal(wired, 0)
})
test('inspect refuses a forum supergroup, whose topics cannot be addressed', async () => {
  const inspect = chat => createTelegramAdapter(wire({ getChat: async () => chat })).inspect('-30', active)
  assert.deepEqual(await inspect({ id: -30, type: 'supergroup', is_forum: true }), { id: '-30', kind: 'group', eligible: false })
  assert.deepEqual(await inspect({ id: -30, type: 'supergroup' }), { id: '-30', kind: 'group', eligible: true })
  assert.equal((await inspect({ id: -30, type: 'channel' })).eligible, false)
})
test('an oversized batch is retried one update at a time, then fails closed', async () => {
  const limits = []
  const huge = { statusCode: 200, body: Readable.from([Buffer.alloc(1024 * 1024 + 1)]) }
  const request = telegramRequest(token, { lookup, request: async (url, options) => {
    if (url.endsWith('/getMe')) return reply(200, { ok: true, result: { id: 7, username: 'fixture_bot' } })
    if (url.endsWith('/setMyCommands')) return reply(200, { ok: true, result: true })
    limits.push(JSON.parse(options.body).limit)
    return { ...huge, body: Readable.from([Buffer.alloc(1024 * 1024 + 1)]) }
  } })
  const fixture = session()
  await assert.rejects(createTelegramAdapter(request).receiveSession(fixture), error => error.failure?.kind === 'blocked')
  assert.deepEqual(limits, [50, 1])
  assert.deepEqual(fixture.accepted, [])
})
test('a long retry_after is waited out in-session and the wait aborts on stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let polls = 0
  const limited = new ExtensionChatError({ kind: 'rate_limited', retryAfterMs: 3_600_000 })
  const fixture = session()
  const running = createTelegramAdapter(wire({ getUpdates: async () => { if (++polls === 1) throw limited; return [] } })).receiveSession(fixture)
  await turn(); await turn(); await turn()
  assert.deepEqual(fixture.states, ['backoff'])
  t.mock.timers.tick(3_599_000); await turn(); await turn()
  assert.equal(polls, 1, 'still waiting one second short of the flood wait')
  t.mock.timers.tick(1000); await running
  assert.equal(polls, 2)

  const stopped = session(); let again = 0
  const pending = createTelegramAdapter(wire({ getUpdates: async () => { again++; throw limited } })).receiveSession(stopped)
  await turn(); await turn(); await turn()
  stopped.controller.abort(); await pending
  assert.equal(again, 1)
})
test('a missed request deadline is transient, so the host retries instead of stopping the bot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hung = telegramRequest(token, { lookup, request: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  const pending = hung('getUpdates', {})
  const rejected = assert.rejects(pending, error => error.failure?.kind === 'transient')
  await turn(); await turn()
  t.mock.timers.tick(35_000); await rejected
})
test('a stalled response body is bounded by the request deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let destroyed = false
  const stalled = telegramRequest(token, { lookup, request: async () => ({ statusCode: 200, body: { destroy() { destroyed = true }, [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } } } }) })
  const rejected = assert.rejects(stalled('getMe', {}), error => error.failure?.kind === 'transient')
  await turn(); await turn()
  t.mock.timers.tick(10_000); await rejected
  assert.equal(destroyed, true)
})
test('one pooled agent serves every call to a pinned address', async () => {
  const dispatchers = []
  let address = '8.8.4.4'
  const pinned = telegramRequest(token, { lookup: async () => [{ address, family: 4 }], request: async (_url, request) => { dispatchers.push(request.dispatcher); return reply(200, { ok: true, result: true }) } })
  await pinned('getMe', {}); await pinned('sendMessage', {}); await Promise.all([pinned('getUpdates', {}), pinned('setMyCommands', {})])
  assert.equal(new Set(dispatchers).size, 1)
  address = '1.1.1.1'; await pinned('getMe', {})
  assert.equal(new Set(dispatchers).size, 2)
})
test('tokens the host accepts construct a request', () => {
  assert.doesNotThrow(() => telegramRequest(`12345:${'A'.repeat(35)}`))
})
test('an update the host schema would reject is checkpointed without an event', async () => {
  const human = { id: 40, is_bot: false, first_name: 'Ada' }, chat = { id: 30, type: 'private' }
  const fixture = session()
  await createTelegramAdapter(wire({ getUpdates: async () => [
    { update_id: 1, message: { message_id: 2, chat, from: human, text: 'no date' } },
    { update_id: 2, message: { message_id: 3, date: 1800000000, chat, from: { ...human, id: -1 }, text: 'negative user' } },
    { update_id: 3, message: { message_id: -4, date: 1800000000, chat, from: human, text: 'negative message' } },
    { update_id: 4, callback_query: { id: 'cb', from: human, data: 'x'.repeat(65), message: { message_id: 5, chat } } },
    { update_id: 5, message: { message_id: 6, date: 1800000000, chat, from: human, text: 'valid' } },
  ] })).receiveSession(fixture)
  assert.deepEqual(fixture.accepted.map(row => row.sequence), [1, 2, 3, 4, 5])
  assert.deepEqual(fixture.accepted.map(row => row.event?.text), [undefined, undefined, undefined, undefined, 'valid'])
})
test('a receipt with a non-positive message id fails closed', async () => {
  const adapter = createTelegramAdapter(wire({ sendMessage: async () => ({ message_id: -1, chat: { id: 30 } }) }))
  await assert.rejects(adapter.send('30', { text: 'x' }, active), error => error.failure?.kind === 'blocked')
})
const human = { id: 123, is_bot: false, first_name: 'Ada' }
const privateChat = { id: 123, type: 'private' }
const command = (text, extra = {}) => ({ message_id: 9, date: 1800000000, chat: privateChat, from: human, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }], ...extra })
async function receive(message) {
  const fixture = session()
  await createTelegramAdapter(wire({ getUpdates: async () => [{ update_id: 1, message }] })).receiveSession(fixture)
  return fixture.accepted[0].event
}
test('only human text in a private chat or group becomes a message', async () => {
  assert.equal((await receive(command('/help'))).kind, 'message')
  assert.equal((await receive(command('/help', { chat: { id: -123, type: 'group' } }))).chat.kind, 'group')
  for (const patch of [{ forward_origin: {} }, { via_bot: {} }, { sender_chat: {} }, { document: {} }, { photo: [] }, { from: { ...human, is_bot: true } }, { message_thread_id: 1 }, { is_topic_message: true }, { chat: { id: 123, type: 'channel' } }, { chat: { id: -123, type: 'supergroup', is_forum: true } }]) {
    assert.equal(await receive(command('/help', patch)), undefined, JSON.stringify(patch))
  }
})
test('only commands at offset zero addressed to this bot are commands', async () => {
  const classify = async message => (await receive(message)).command
  assert.deepEqual(await classify(command('/reply@FIXTURE_bot abcdef12 yes')), { kind: 'command', name: 'reply', args: 'abcdef12 yes' })
  assert.deepEqual(await classify(command('/help@other')), { kind: 'ignore' })
  assert.deepEqual(await classify(command('/shell rm')), { kind: 'unknown' })
  assert.deepEqual(await classify({ ...command('/help'), entities: [] }), { kind: 'unknown' })
  assert.deepEqual(await classify({ ...command('hello /help'), entities: [{ type: 'bot_command', offset: 6, length: 5 }] }), { kind: 'text' })
})
test('large negative supergroup ids survive without truncation', async () => {
  assert.equal((await receive(command('/help', { chat: { id: -1001234567890, type: 'supergroup' } }))).chat.id, '-1001234567890')
})
