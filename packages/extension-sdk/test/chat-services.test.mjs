import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sdk from '../dist/chat.js'

const epoch = '01234567-89ab-4cde-8fab-0123456789ab'
const event = { kind: 'message', id: 'event-1', chat: { id: 'private:1', kind: 'private' },
  user: { id: '1', label: 'User' }, messageId: '2', at: 1, text: 'help', addressed: true }

test('ordered acceptance preserves a no-op checkpoint and rejects unsafe successor arithmetic', () => {
  assert.deepEqual(sdk.chatDeliverySchema.parse({ kind: 'ordered', epoch, sequence: 0 }), { kind: 'ordered', epoch, sequence: 0 })
  for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'ordered', epoch, sequence }).success, false)
  }
})

test('opaque events cannot claim a platform cursor or another epoch', () => {
  assert.deepEqual(sdk.chatDeliverySchema.parse({ kind: 'event', event }), { kind: 'event', event })
  assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'event', event, epoch, sequence: 1 }).success, false)
})

test('accepted responses require a host checkpoint and a known disposition', () => {
  assert.deepEqual(sdk.chatAcceptedSchema.parse({ disposition: 'duplicate', checkpoint: { epoch, nextSequence: null } }),
    { disposition: 'duplicate', checkpoint: { epoch, nextSequence: null } })
  for (const checkpoint of [{ epoch: 'worker', nextSequence: 1 }, { epoch, nextSequence: -1 }, { epoch }]) {
    assert.equal(sdk.chatAcceptedSchema.safeParse({ disposition: 'accepted', checkpoint }).success, false)
  }
  assert.equal(sdk.chatAcceptedSchema.safeParse({ disposition: 'failed', checkpoint: { epoch, nextSequence: 1 } }).success, false)
})

test('native interactions carry actor identity but cannot choose a project or send wire tokens', () => {
  const input = { kind: 'task-autocomplete', eventId: 'interaction-1', chat: event.chat, user: event.user, at: 1 }
  assert.deepEqual(sdk.chatInteractionInputSchema.parse(input), input)
  for (const extra of [{ projectId: 'other' }, { token: 'wire-secret' }, { at: -1 }]) {
    assert.equal(sdk.chatInteractionInputSchema.safeParse({ ...input, ...extra }).success, false)
  }
})

test('native results have platform-sized bounded fields and count', () => {
  const choice = { name: 'Task', value: 'task-id' }
  assert.deepEqual(sdk.chatTaskChoicesSchema.parse([choice]), [choice])
  assert.equal(sdk.chatTaskChoicesSchema.safeParse(Array(26).fill(choice)).success, false)
  assert.equal(sdk.chatTaskChoicesSchema.safeParse([{ ...choice, name: 'x'.repeat(101) }]).success, false)
  assert.equal(sdk.chatTaskChoicesSchema.safeParse([{ ...choice, value: '' }]).success, false)
})

test('session deliveries reject unknown nested authority fields instead of stripping them', () => {
  for (const extra of [
    { projectId: 'other' }, { chat: { ...event.chat, projectId: 'other' } },
    { user: { ...event.user, token: 'secret' } },
    { command: { kind: 'command', name: 'tasks', args: '', authorized: true } },
    { replyTo: { chatId: event.chat.id, messageId: '3', token: 'secret' } },
  ]) {
    assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'event', event: { ...event, ...extra } }).success, false)
  }
})

test('session normalization preserves bounded command and chat metadata', () => {
  const normalized = { ...event, pairingEligible: false, title: 'Group title',
    command: { kind: 'command', name: 'tasks', args: '' } }
  assert.deepEqual(sdk.chatDeliverySchema.parse({ kind: 'event', event: normalized }).event, normalized)
  assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'event', event: { ...normalized, command: { kind: 'command', name: 'admin', args: '' } } }).success, false)
  assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'event', event: { ...normalized, title: 'x'.repeat(257) } }).success, false)
})

test('session membership has bounded affected destinations and retains the primary identity', () => {
  const membership = { kind: 'membership', id: 'membership-1', chat: event.chat, reason: 'removed', affectedChatIds: [event.chat.id, 'group:2'] }
  assert.deepEqual(sdk.chatDeliverySchema.parse({ kind: 'event', event: membership }).event, membership)
  for (const affectedChatIds of [[], ['other'], Array(11).fill(event.chat.id)]) {
    assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'event', event: { ...membership, affectedChatIds } }).success, false)
  }
})

test('health reports and native queries cannot smuggle timestamps or unbounded input', () => {
  assert.deepEqual(sdk.chatReceiveHealthSchema.parse({ state: 'polling' }), { state: 'polling' })
  assert.equal(sdk.chatReceiveHealthSchema.safeParse({ state: 'polling', lastSuccessfulPollAt: 0 }).success, false)
  assert.equal(sdk.chatReceiveHealthSchema.safeParse({ state: 'unknown' }).success, false)
  assert.equal(sdk.chatTaskQuerySchema.parse(''), '')
  assert.equal(sdk.chatTaskQuerySchema.safeParse('x'.repeat(129)).success, false)
})
