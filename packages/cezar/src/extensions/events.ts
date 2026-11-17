import type { ExtensionTaskEvent } from '@open-mercato/cezar-contract'

export type ExtensionEventListener = (event: ExtensionTaskEvent) => void

/** Bounded, informational event fan-out. Events are never replayed as mutations. */
export class ExtensionTaskEventBus {
  private readonly listeners = new Set<ExtensionEventListener>()
  private sequence = 0
  subscribe(listener: ExtensionEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  publish(event: Omit<ExtensionTaskEvent, 'sequence'>): void {
    const value = { ...event, sequence: ++this.sequence }
    for (const listener of [...this.listeners]) {
      try { listener(value) } catch { /* an extension cannot break the host */ }
    }
  }
}
