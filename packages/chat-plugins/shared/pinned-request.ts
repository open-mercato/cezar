// One outbound policy for every shipped adapter (spec 2026-11-09). Copied into each plugin's
// src by sync.mjs so its artifact stays self-contained; node built-ins only, it resolves from any plugin.
import { isIP } from 'node:net'

export type Address = { address: string; family: number }
export type Lookup = (hostname: string, signal?: AbortSignal) => Promise<Address[]>
type Failure = (kind: 'blocked' | 'transient') => Error
export const MAX_RESPONSE_BYTES = 1024 * 1024

const v4 = (address: string) => address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0)
const in4 = (address: number, network: string, bits: number) => Math.floor(address / 2 ** (32 - bits)) === Math.floor(v4(network) / 2 ** (32 - bits))
const nonPublic4: readonly (readonly [string, number])[] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
const public4 = (address: string) => { const value = v4(address); return !nonPublic4.some(([network, bits]) => in4(value, network, bits)) }
function v6(address: string): bigint {
 let value = address.toLowerCase()
 if (value.includes('.')) { const colon = value.lastIndexOf(':'); const tail = v4(value.slice(colon + 1)); value = value.slice(0, colon + 1) + Math.floor(tail / 65536).toString(16) + ':' + (tail % 65536).toString(16) }
 const [left = '', right] = value.split('::'); const a = left ? left.split(':') : []; const b = right ? right.split(':') : []
 const words = right === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b]
 return words.reduce((result, word) => (result << 16n) + BigInt(`0x${word}`), 0n)
}
const in6 = (address: bigint, network: string, bits: number) => (address >> BigInt(128 - bits)) === (v6(network) >> BigInt(128 - bits))
export function publicAddress(input: string): boolean {
 const address = input.replace(/^\[|\]$/g, '')
 if (isIP(address) === 4) return public4(address)
 if (isIP(address) !== 6 || address.includes('%')) return false
 const value = v6(address)
 if (in6(value, '::ffff:0:0', 96) || in6(value, '::', 96)) {
  if (value === 0n || value === 1n) return false
  const embedded = Number(value & 0xffffffffn)
  return public4([24, 16, 8, 0].map(shift => (embedded >>> shift) & 255).join('.'))
 }
 // Global unicast only, minus the Teredo/benchmark, documentation, 6to4 and 3fff::/20 blocks.
 return in6(value, '2000::', 3) && !in6(value, '2001::', 23) && !in6(value, '2001:db8::', 32) && !in6(value, '2002::', 16) && !in6(value, '3fff::', 20)
}
/** Every resolved address must be public, so one poisoned record refuses the whole host. */
export function publicTarget(addresses: readonly Address[], fail: Failure): Address {
 const valid = addresses.filter(item => publicAddress(item.address) && item.family === isIP(item.address))
 if (!valid.length || valid.length !== addresses.length) throw fail('blocked')
 return valid[0]!
}
export async function pinPublicAddress(hostname: string, lookup: Lookup, signal: AbortSignal, timeoutMs: number, fail: Failure): Promise<Address> {
 const controller = new AbortController(); let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined
 const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true })
 try {
  if (signal.aborted) throw fail('blocked')
  const addresses = await new Promise<Address[]>((resolve, reject) => {
   const onAbort = () => { controller.abort(); reject(fail(timedOut ? 'transient' : 'blocked')) }
   controller.signal.addEventListener('abort', onAbort, { once: true })
   timer = setTimeout(() => { timedOut = true; onAbort() }, timeoutMs)
   Promise.resolve().then(() => lookup(hostname, controller.signal)).then(resolve, reject)
  })
  return publicTarget(addresses, fail)
 } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
/** Dial options that can only reach the validated address. */
export function pinnedConnect(target: Address) {
 return { rejectUnauthorized: true, autoSelectFamily: false,
  lookup(_hostname: string, options: { all?: boolean }, callback: (error: Error | null, address: any, family?: number) => void) {
   if (options.all) callback(null, [target])
   else callback(null, target.address, target.family)
  } }
}
/** `signal` bounds a stalled body: the deadline must hold even when the stream ignores cancellation. */
export async function readCapped(body: AsyncIterable<Uint8Array> & { destroy?(): unknown }, fail: Failure, signal?: AbortSignal): Promise<Buffer> {
 const chunks: Buffer[] = []; let length = 0, cancel = () => {}
 const aborted = new Promise<never>((_, reject) => { cancel = () => reject(fail('transient')) })
 aborted.catch(() => {})
 if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true })
 const read = (async () => {
  for await (const chunk of body) {
   length += chunk.length
   if (length > MAX_RESPONSE_BYTES) throw fail('blocked')
   chunks.push(Buffer.from(chunk))
  }
 })()
 try { await Promise.race([read, aborted]) } finally { signal?.removeEventListener('abort', cancel); body.destroy?.() }
 read.catch(() => {})
 return Buffer.concat(chunks)
}
