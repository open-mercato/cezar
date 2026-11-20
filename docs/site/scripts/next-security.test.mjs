import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
// Initialize the same async-storage globals as Next's Node server before loading its adapters.
require('next/dist/server/node-environment-baseline.js')
const { defaultConfig } = require('next/dist/server/config-shared.js')
const { detectContentType } = require('next/dist/server/image-optimizer/detect-content-type.js')
const { imageOptimizerTransform } = require('next/dist/server/image-optimizer/transform.js')
const { adapter } = require('next/dist/server/web/adapter.js')
const { NextResponse } = require('next/server')
const { NodeNextResponse } = require('next/dist/server/base-http/node.js')
const { sendResponse } = require('next/dist/server/send-response.js')

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>'
const imageParams = { href: '/fixture', quality: 75, width: 64, mimeType: 'image/png' }

function optimize(buffer, dangerouslyAllowSVG = false) {
  return imageOptimizerTransform(
    { buffer, etag: 'fixture', cacheControl: 'max-age=60' },
    imageParams,
    { ...defaultConfig, images: { ...defaultConfig.images, dangerouslyAllowSVG } },
  )
}

// Dependabot95 / GHSA-7qx7-33qx-rqx2: XML comments must not disguise SVG as AVIF/HEIC.
for (const brand of ['avif', 'heic']) {
  test(`rejects SVG disguised with an ftyp ${brand} comment`, async () => {
    await assert.rejects(optimize(Buffer.from(`<!--ftyp${brand}-->${svg}`)), {
      statusCode: 400,
    })
  })

  test(`still identifies a bounded ${brand} ftyp box`, async () => {
    const buffer = Buffer.alloc(16)
    buffer.writeUInt32BE(16)
    buffer.write(`ftyp${brand}`, 4, 'ascii')
    assert.equal(await detectContentType(buffer), `image/${brand}`)
  })
}

test('SVG remains available only with explicit opt-in', async () => {
  await assert.rejects(optimize(Buffer.from(svg)), { statusCode: 400 })
  const allowed = await optimize(Buffer.from(svg), true)
  assert.equal(allowed.contentType, 'image/svg+xml')
  assert.equal(allowed.buffer.toString(), svg)
})

test('ordinary raster images still pass through the optimizer', async () => {
  const sharp = require('sharp')
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer()
  const result = await optimize(buffer)
  assert.equal(result.error, undefined)
  assert.equal(result.contentType, 'image/png')
  assert.equal((await sharp(result.buffer).metadata()).width, 2)
})

async function cookieResponse(page) {
  const result = await adapter({
    page,
    request: {
      url: 'http://localhost/security-fixture', method: 'GET', headers: {}, body: null,
      signal: new AbortController().signal,
      nextConfig: { experimental: {}, cacheLife: {} },
    },
    handler: async () => {
      const response = NextResponse.json({ ok: true })
      response.cookies.set('session', 'fixture-value', { httpOnly: true })
      return response
    },
  })
  await result.waitUntil
  return result.response
}

// Dependabot94 / GHSA-f3mh-rxg3-f5g2: HttpOnly cookies must not leak in a readable header.
for (const page of ['/api/security-fixture', '/app/security-fixture/route']) {
  test(`Edge route ${page} keeps cookies out of internal response headers`, async () => {
    const response = await cookieResponse(page)
    assert.match(response.headers.get('set-cookie'), /session=fixture-value;.*HttpOnly/)
    assert.equal(response.headers.get('x-middleware-set-cookie'), null)
    assert.deepEqual(await response.json(), { ok: true })
  })
}

test('middleware retains its internal cookie propagation header', async () => {
  const response = await cookieResponse('/middleware')
  assert.match(response.headers.get('x-middleware-set-cookie'), /session=fixture-value/)
})

async function server(t, handler) {
  const instance = http.createServer(handler)
  t.after(async () => {
    instance.closeAllConnections()
    await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()))
  })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  return `http://127.0.0.1:${instance.address().port}`
}

// Dependabot93 / GHSA-pc58-hwjq-p385: decoded fetch bodies need fresh response framing.
test('forwarding a fetched gzip response preserves the complete decoded body', { timeout: 10000 }, async t => {
  const payload = 'Documentation response forwarded through Next.js.\n'.repeat(100)
  const compressed = gzipSync(payload)
  const upstream = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': compressed.length })
    response.end(compressed)
  })
  const downstream = await server(t, async (request, response) => {
    try {
      const fetched = await fetch(upstream, { signal: AbortSignal.timeout(3000) })
      await sendResponse(request, new NodeNextResponse(response), fetched)
    } catch (error) {
      response.destroy(error)
    }
  })
  const response = await fetch(downstream, { signal: AbortSignal.timeout(3000) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.notEqual(response.headers.get('content-length'), String(compressed.length))
  assert.equal(await response.text(), payload)
})
