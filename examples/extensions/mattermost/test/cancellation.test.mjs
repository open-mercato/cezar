import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeOperation, fixture } from './fixture.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
// Deliberately structural: this is not a native AbortSignal.
function operation() {
  const controller = new AbortController(), listeners = new Set()
  let revoked = false, checks = 0
  return {
    context: {
      signal: {
        get aborted() { return controller.signal.aborted },
        throwIfAborted() { controller.signal.throwIfAborted() },
        addEventListener(type, listener, options) { listeners.add(listener); controller.signal.addEventListener(type, listener, options) },
        removeEventListener(type, listener) { listeners.delete(listener); controller.signal.removeEventListener(type, listener) },
      },
      async assertActive() { checks++; if (revoked) throw Error('revoked') },
    },
    abort() { controller.abort() }, revoke() { revoked = true },
    get listeners() { return listeners.size }, get checks() { return checks },
  }
}

for (const action of ['revoke', 'abort']) {
  test(`${action} during async storage preparation prevents subsequent HTTP`, async () => {
    const entered = deferred(), release = deferred()
    const x = await fixture({ beforeGet: async () => { entered.resolve(); await release.promise } })
    const op = operation()
    try {
      const pending = x.receive(null, op.context)
      await entered.promise
      assert.equal(x.requests.length, 1, 'identity completed before storage preparation')
      op[action]()
      release.resolve()
      await assert.rejects(pending)
      assert.equal(x.requests.length, 1, 'no channel or page request after cancellation')
      assert.equal(op.listeners, 0)
    } finally { release.resolve(); await x.close() }
  })
}

test('aborting an in-flight send is isolated from another operation and removes listeners', async () => {
  const x = await fixture(), first = operation(), second = operation()
  const entered = deferred()
  const signals = []
  const mockFetch = globalThis.fetch
  globalThis.fetch = (url, options) => {
    signals.push(options.signal)
    if (signals.length === 1) {
      entered.resolve()
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
    }
    return mockFetch(url, options)
  }
  try {
    const pending = x.adapter.send(x.chat, { text: 'first' }, first.context)
    const rejected = assert.rejects(pending, /aborted/)
    await entered.promise
    await x.adapter.send(x.chat, { text: 'second' }, second.context)
    first.abort()
    // Prevent an ignored cancellation from hanging the regression run.
    await Promise.race([rejected, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('operation did not abort fetch')), 1000)
      timer.unref()
    })])
    assert.equal(signals[0].aborted, true)
    assert.equal(signals[1].aborted, false)
    assert.equal(first.listeners, 0)
    assert.equal(second.listeners, 0)
    assert.equal(first.checks, 1)
    assert.equal(second.checks, 1)
    assert.deepEqual(x.sent.map(row => row.message), ['second'])
  } finally { await x.close() }
})

test('dispose aborts an in-flight send', async () => {
  const x = await fixture(), entered = deferred()
  globalThis.fetch = (url, options) => {
    entered.resolve()
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('disposed')), { once: true }))
  }
  try {
    const pending = assert.rejects(x.adapter.send(x.chat, { text: 'in flight' }, activeOperation()), /disposed/)
    await entered.promise
    await x.adapter.dispose()
    await pending
  } finally { await x.close() }
})
