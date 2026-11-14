import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
// Exercise the copy the preview server actually loads, including a nested override.
const compressionPath = require.resolve('compression', {
  paths: [dirname(require.resolve('serve/package.json'))],
})
const compression = require(compressionPath)
const payload = Buffer.from('Documentation response streamed to a browser.\n'.repeat(4096))
const codecs = [
  ['gzip', 'createGzip', zlib.gunzipSync],
  ['deflate', 'createDeflate', zlib.inflateSync],
  ['br', 'createBrotliCompress', zlib.brotliDecompressSync],
]

async function fixture(t, factory, handler) {
  const streams = []
  const descriptor = Object.getOwnPropertyDescriptor(zlib, factory)
  Object.defineProperty(zlib, factory, {
    ...descriptor,
    value(...args) {
      const stream = descriptor.value.apply(this, args)
      streams.push(stream)
      return stream
    },
  })

  const sockets = new Set()
  const middleware = compression({ threshold: 0 })
  const server = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.setHeader('Content-Type', 'text/plain')
      handler(req, res)
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    // Also clean up the intentionally vulnerable baseline after assertions run.
    for (const stream of streams) stream.destroy()
    Object.defineProperty(zlib, factory, descriptor)
    await new Promise(resolve => server.close(resolve))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { port: server.address().port, streams }
}

function request(t, port, encoding, onResponse) {
  const req = http.get({
    hostname: '127.0.0.1', port, agent: false,
    headers: { 'Accept-Encoding': encoding },
  }, onResponse)
  t.after(() => req.destroy())
  return req
}

// GHSA-vc2v-76pw-4v95: a client disconnect must free the real native zlib
// handle, even though the producer has not ended its compressed response.
for (const [encoding, factory, decompress] of codecs) {
  test(`aborted ${encoding} response releases its native compressor`, { timeout: 5000 }, async t => {
    let responseClosed
    const closed = new Promise(resolve => { responseClosed = resolve })
    const { port, streams } = await fixture(t, factory, (_req, res) => {
      res.once('close', responseClosed)
      res.write(payload)
      res.flush()
      // Deliberately leave the response unfinished until the client disconnects.
    })
    await new Promise((resolve, reject) => {
      const req = request(t, port, encoding, res => {
        res.once('error', reject)
        res.once('data', () => {
          try {
            assert.equal(res.headers['content-encoding'], encoding)
            assert.equal(streams.length, 1)
            assert.ok(streams[0]._handle, 'a native compressor was allocated before abort')
            res.destroy()
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })
      req.once('error', reject)
    })
    await closed
    // Cleanup can complete on the next event-loop turn; bound the wait on broken versions.
    for (let attempt = 0; attempt < 50 && streams[0]._handle !== null; attempt++) {
      await delay(10)
    }
    assert.equal(streams[0]._handle === null, true, 'client abort must release the native zlib handle')
    assert.equal(streams[0].destroyed, true, 'client abort must destroy the compression stream')
  })

  test(`complete ${encoding} response still decompresses without data loss`, { timeout: 5000 }, async t => {
    const { port, streams } = await fixture(t, factory, (_req, res) => res.end(payload))
    const { headers, body } = await new Promise((resolve, reject) => {
      request(t, port, encoding, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.once('error', reject)
        res.once('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
      }).once('error', reject)
    })
    assert.equal(headers['content-encoding'], encoding)
    assert.equal(streams.length, 1)
    assert.ok(body.length < payload.length)
    assert.deepEqual(decompress(body), payload)
  })
}

test('identity response stays uncompressed', { timeout: 5000 }, async t => {
  const { port, streams } = await fixture(t, 'createGzip', (_req, res) => res.end(payload))
  const { headers, body } = await new Promise((resolve, reject) => {
    request(t, port, 'identity', res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('error', reject)
      res.once('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    }).once('error', reject)
  })
  assert.equal(headers['content-encoding'], undefined)
  assert.equal(streams.length, 0)
  assert.deepEqual(body, payload)
})
