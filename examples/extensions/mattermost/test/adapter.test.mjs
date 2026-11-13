import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeOperation, fixture, id, post } from './fixture.mjs'

test('renders core confirmation choices and receives them as receipt-bound button events', async () => {
  const x = await fixture()
  try {
    const receipt = await x.adapter.send(x.chat, { text: 'Start a task?', buttons: [[{ text: 'Confirm', data: 'opaque-confirmation' }, { text: 'Cancel', data: 'opaque-cancel' }]] }, activeOperation())
    assert.match(x.sent[0].message, /Confirm.*cezar choose opaque-confirmation/)
    assert.match(x.sent[0].message, /Cancel.*cezar choose opaque-cancel/)
    x.posts.push(post(1, { message: 'cezar choose opaque-confirmation' }))
    const [row] = await x.receive(null)
    assert.equal(row.event.kind, 'button')
    assert.deepEqual(row.event.receipt, receipt)
    assert.equal(row.event.user.id, id('u'))
    assert.equal(row.event.data, 'opaque-confirmation')
  } finally { await x.close() }
})

test('101 equal timestamps drain across restart, replay unacknowledged rows and accept later posts', async () => {
  const x = await fixture()
  try {
    x.posts.push(...Array.from({ length: 101 }, (_, n) => post(n + 1)))
    assert.deepEqual(await x.receive(null), [], 'incomplete catch-up must not emit newer commands')
    const first = await x.receive(null)
    assert.equal(first.length, 100)
    await x.restart()
    assert.deepEqual(await x.receive(null), first)
    const partial = await x.receive(first[49].sequence)
    assert.deepEqual(partial, first.slice(50))
    const second = await x.receive(first.at(-1).sequence)
    assert.equal(second.length, 1)
    assert.equal(new Set([...first, ...second].map(row => row.event.id)).size, 101)
    assert.ok(second[0].sequence > first.at(-1).sequence)
    x.posts.push(post(102, { create_at: x.now + 1 }))
    let after = second[0].sequence, later = false
    for (let i = 0; i < 6 && !later; i++) {
      const rows = await x.receive(after)
      later = rows.some(row => row.event.id === id(102))
      after = rows.at(-1)?.sequence ?? after
    }
    assert.ok(later, 'later post must not starve')
  } finally { await x.close() }
})

test('1001 timestamp ties and multiple channels drain with bounded requests and no duplicate delivery', async () => {
  const x = await fixture()
  try {
    x.posts.push(...Array.from({ length: 1001 }, (_, n) => post(n + 1)))
    x.posts.push(post(2000, { channel_id: id('g') }))
    const delivered = []
    let after = null
    for (let i = 0; i < 30; i++) {
      const start = x.requests.length
      const rows = await x.receive(after)
      assert.ok(x.requests.length - start <= 3)
      assert.ok(rows.length <= 100)
      delivered.push(...rows.map(row => row.event.id))
      after = rows.at(-1)?.sequence ?? after
      if (i === 4) await x.restart()
    }
    assert.equal(delivered.length, 1002)
    assert.equal(new Set(delivered).size, 1002)
    // A newly visible post at the exact old boundary must not be filtered away.
    x.posts.push(post(2001))
    let seen = false
    for (let i = 0; i < 30 && !seen; i++) {
      const rows = await x.receive(after)
      seen = rows.some(row => row.event.id === id(2001))
      after = rows.at(-1)?.sequence ?? after
    }
    assert.ok(seen)
  } finally { await x.close() }
})

test('failed durable page write cannot skip data on retry or restart', async () => {
  const x = await fixture()
  try {
    x.posts.push(...Array.from({ length: 101 }, (_, n) => post(n + 1)))
    x.failWrite()
    await assert.rejects(x.receive(null), /storage failed/)
    await x.restart()
    assert.deepEqual(await x.receive(null), [], 'incomplete catch-up must not emit newer commands')
    x.failWrite()
    await assert.rejects(x.receive(null), /storage failed/)
    await x.restart()
    const first = await x.receive(null)
    assert.equal(first.length, 100)
    x.failWrite()
    await assert.rejects(x.receive(first.at(-1).sequence), /storage failed/)
    await x.restart()
    const second = await x.receive(first.at(-1).sequence)
    assert.equal(second.length, 1)
    assert.equal(new Set([...first, ...second].map(row => row.event.id)).size, 101)
  } finally { await x.close() }
})

test('catch-up emits chronological order across pages, including after a scan restart', async () => {
  const x = await fixture()
  try {
    x.posts.push(...Array.from({ length: 205 }, (_, n) => post(n + 1, { create_at: x.now + n })))
    const delivered = []
    let after = null
    for (let i = 0; i < 10 && delivered.length < 205; i++) {
      const rows = await x.receive(after)
      delivered.push(...rows.map(row => row.event.id))
      after = rows.at(-1)?.sequence ?? after
      if (i === 0) await x.restart()
    }
    assert.deepEqual(delivered, x.posts.map(row => row.id))
  } finally { await x.close() }
})
