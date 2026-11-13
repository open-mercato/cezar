// Node fires a timer over 2^31-1 ms after 1 ms.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { createTelegramAdapter } from '../dist/adapter.js'

const settle = async (turns = 6) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)) }
const epoch = '11111111-1111-4111-8111-111111111111', MAX_TIMER = 2 ** 31 - 1

function clock(t) {
 t.mock.timers.enable({ apis: ['setTimeout'] })
 // The mock honours any delay; model what the real timer does with an overflowing one.
 const mocked = globalThis.setTimeout
 globalThis.setTimeout = (callback, ms, ...args) => mocked(callback, ms > MAX_TIMER ? 1 : ms, ...args)
 t.after(() => { globalThis.setTimeout = mocked })
}
function fixture(retryAfterMs) {
 const controller = new AbortController(), state = { polls: 0, controller }
 const request = async method => {
  if (method === 'getMe') return { id: 7, username: 'fixture_bot' }
  if (method === 'getUpdates' && ++state.polls === 1) throw new ExtensionChatError({ kind: 'rate_limited', retryAfterMs })
  if (method === 'getUpdates') { controller.abort(); return [] }
  return true
 }
 const session = { signal: controller.signal, assertActive: async () => {}, checkpoint: async () => ({ epoch, nextSequence: null }), accept: async () => {}, health: async () => {} }
 state.pending = createTelegramAdapter(request).receiveSession(session)
 return state
}

test('a flood wait beyond the timer range is honoured', async t => {
 clock(t)
 const wait = 3e9, s = fixture(wait); await settle()
 assert.equal(s.polls, 1)
 t.mock.timers.tick(1); await settle()
 assert.equal(s.polls, 1, 'must not fire at once')
 t.mock.timers.tick(MAX_TIMER - 1); await settle()
 assert.equal(s.polls, 1, 'the first chunk elapsed, the wait has not')
 t.mock.timers.tick(wait - MAX_TIMER - 1); await settle()
 assert.equal(s.polls, 1, 'one millisecond short')
 t.mock.timers.tick(1); await settle()
 assert.equal(s.polls, 2, 'polls again when the wait elapsed')
 await s.pending
})

test('abort ends a long flood wait at once', async t => {
 clock(t)
 const s = fixture(3e9); await settle()
 s.controller.abort(); await settle()
 await s.pending
 assert.equal(s.polls, 1)
})
