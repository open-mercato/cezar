// Helpers every shipped adapter shares. Copied into each plugin's src by sync.mjs so its
// artifact stays self-contained; node built-ins only, it resolves from any plugin.
import { pinnedConnect, type Address } from './pinned-request.js'

type PooledAgent = { close(): Promise<unknown> }
type Pooled<A> = { agent: A; holders: number; retired: boolean }
const POOL_SIZE = 4
export type AgentLease<A> = { agent: A; release(): void }
export type AgentPool<A> = { lease(target: Address): AgentLease<A>; close(): void }

/** A reply must not pay a TLS handshake per call; each agent stays pinned to its validated address.
 * Least recently used goes first, and a retired agent closes only once no request holds it. */
export function agentPool<A extends PooledAgent>(Agent: new (options: { connections: number; pipelining: number; connect: ReturnType<typeof pinnedConnect> }) => A): AgentPool<A> {
 const agents = new Map<string, Pooled<A>>()
 const shut = (entry: Pooled<A>) => { if (entry.retired && !entry.holders) void entry.agent.close().catch(() => undefined) }
 const retire = (entry: Pooled<A>) => { entry.retired = true; shut(entry) }
 return {
  lease(target) {
   const key = `${target.family}/${target.address}`
   const entry = agents.get(key) ?? { agent: new Agent({ connections: 4, pipelining: 1, connect: pinnedConnect(target) }), holders: 0, retired: false }
   agents.delete(key)
   agents.set(key, entry)
   entry.holders++
   for (const [stale, old] of agents) { if (agents.size <= POOL_SIZE) break; agents.delete(stale); retire(old) }
   let released = false
   return { agent: entry.agent, release: () => { if (released) return; released = true; entry.holders--; shut(entry) } }
  },
  // Later leases build fresh agents, so closing a request another adapter shares only costs a handshake.
  close() { for (const entry of agents.values()) retire(entry); agents.clear() },
 }
}

// A timer over 2^31-1 ms fires at once, so a longer wait sleeps in chunks.
const MAX_TIMER_MS = 2 ** 31 - 1
// Wide enough for AbortSignal and the SDK's narrower operation signal.
type DelaySignal = { readonly aborted: boolean; addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void; removeEventListener(type: 'abort', listener: () => void): void }
function sleep(ms: number, signal: DelaySignal): Promise<void> {
 return new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', done, { once: true })
  if (signal.aborted) done()
 })
}
/** Resolves after `ms`, or as soon as `signal` aborts; never rejects. */
export async function abortableDelay(ms: number, signal: DelaySignal): Promise<void> {
 for (let left = ms; left > 0 && !signal.aborted; left -= MAX_TIMER_MS) await sleep(Math.min(left, MAX_TIMER_MS), signal)
}

/** A Retry-After in seconds as milliseconds; a missing or unusable value waits five seconds. */
export function retryAfterMs(value: unknown, capSeconds = Infinity): number {
 const seconds = Number(Array.isArray(value) ? value[0] : value)
 return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, capSeconds) * 1000 : 5000
}

/** Insert as newest, evicting the oldest entry past `limit`. */
export function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
 map.delete(key)
 map.set(key, value)
 if (map.size > limit) map.delete(map.keys().next().value!)
}
