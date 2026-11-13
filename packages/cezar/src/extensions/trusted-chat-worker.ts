import { isDeepStrictEqual } from 'node:util'
import { createExtensionRuntime } from './extension-worker.ts'
import { isVerifiedChatDelivery, type ChatDeliveryArtifact } from './delivery-catalog.ts'
import type { WorkerProcess, WorkerProcessOptions } from './worker-process.ts'
import { encodeFrame } from './rpc.ts'

/** No child process: only a verified shipped artifact may enter this facade. */
export function trustedChatWorker(artifact: ChatDeliveryArtifact, callbacks: Pick<WorkerProcessOptions, 'onFrame' | 'onExit'>): Omit<WorkerProcess, 'child'> {
  if (!isVerifiedChatDelivery(artifact)) throw Error('In-process chat requires a verified shipped artifact')
  let alive = true, closing: Promise<void> | undefined
  let exited!: () => void
  const exit = new Promise<void>(resolve => { exited = resolve; })
  const work = new Set<Promise<unknown>>()
  const runtime = createExtensionRuntime(frame => {
    const serialized = encodeFrame(frame)
    queueMicrotask(() => {
      if (!alive) return
      try { callbacks.onFrame(JSON.parse(serialized)); }
      catch { void stop().catch(() => undefined); }
    })
  })
  const stop = () => closing ??= (async () => {
    // Trusted code still must settle before ownership can pass to a successor.
    // Unlike a process, it cannot be killed while effects are in flight.
    const failures: unknown[] = []
    try { await runtime.dispose(); } catch (error) { failures.push(error); }
    for (const result of await Promise.allSettled([...work])) if (result.status === 'rejected') failures.push(result.reason)
    alive = false; exited()
    callbacks.onExit(failures.length ? new AggregateError(failures, 'trusted chat facade cleanup failed') : new Error('trusted chat facade stopped'))
  })()
  return {
    get alive() { return alive; }, exited: exit, congested: false,
    write(frame) {
      if (!alive || closing) throw Error('trusted chat facade stopped')
      const parsed = JSON.parse(encodeFrame(frame))
      // The public host validates all frames; additionally bind activation to
      // the exact artifact whose provenance permitted in-process execution.
      if (parsed.method === 'activate' && (parsed.params?.entry !== artifact.entry || !isDeepStrictEqual(parsed.params?.manifest, artifact.manifest))) throw Error('Untrusted facade activation')
      const running = Promise.resolve().then(() => runtime.handle(parsed))
      work.add(running)
      void running.finally(() => work.delete(running)).catch(() => { void stop().catch(() => undefined); })
    },
    kill() { void stop().catch(() => undefined); },
    timedOut() { void stop().catch(() => undefined); }, answered() {}, stderrTail: () => '', stop,
  }
}
