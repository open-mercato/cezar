#!/usr/bin/env node
// Runs noise.mjs against the published vectors in ../noise-published/vectors.json.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HandshakeState } from './noise.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { vectors } = JSON.parse(readFileSync(join(here, '../noise-published/vectors.json'), 'utf8'))
const hex = (text) => Buffer.from(text, 'hex')
const EMPTY = Buffer.alloc(0)
const party = (vector, side, initiator, pattern) =>
  new HandshakeState({
    pattern,
    initiator,
    prologue: hex(vector[`${side}_prologue`]),
    s: hex(vector[`${side}_static`]),
    rs: vector[`${side}_remote_static`] ? hex(vector[`${side}_remote_static`]) : null,
    psk: vector[`${side}_psks`]?.[0] ? hex(vector[`${side}_psks`][0]) : null,
    e: hex(vector[`${side}_ephemeral`]),
  })

let messages = 0
for (const vector of vectors) {
  const pattern = /^Noise_(\w+?)_25519/.exec(vector.protocol_name)[1]
  const initiator = party(vector, 'init', true, pattern)
  const responder = party(vector, 'resp', false, pattern)
  let transport = null
  vector.messages.forEach((message, index) => {
    const [from, to] = index % 2 === 0 ? [initiator, responder] : [responder, initiator]
    let ciphertext
    let plaintext
    if (!initiator.done) {
      ciphertext = from.writeMessage(hex(message.payload))
      plaintext = to.readMessage(ciphertext)
    } else {
      transport ??= { i: initiator.split(), r: responder.split() }
      const [out, back] = index % 2 === 0 ? [transport.i, transport.r] : [transport.r, transport.i]
      ciphertext = out.send.encrypt(EMPTY, hex(message.payload))
      plaintext = back.receive.decrypt(EMPTY, ciphertext)
    }
    if (ciphertext.toString('hex') !== message.ciphertext || plaintext.toString('hex') !== message.payload) {
      throw new Error(`${vector.source} ${vector.protocol_name}: message ${index} differs`)
    }
    messages += 1
  })
  if (vector.handshake_hash && initiator.h.toString('hex') !== vector.handshake_hash) {
    throw new Error(`${vector.source} ${vector.protocol_name}: handshake hash differs`)
  }
  console.log(`ok ${vector.source} ${vector.protocol_name} (${vector.messages.length} messages)`)
}
console.log(`published: ${vectors.length} vectors, ${messages} messages passed`)
