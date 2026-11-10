/**
 * Idempotent `POST /runs/:id/messages` (telemetry 1a212342, 29c3ba11). A remote cockpit's POST can
 * die on a pooled socket its reverse proxy already closed, and browsers never retry a POST — so the
 * cockpit retries with the same `idempotencyKey`, and a key that already landed answers its first
 * response instead of delivering the message twice. In memory on purpose: a retry comes seconds
 * later, and a restart already drops the session the message was for.
 */

type Settle<T> = (result: T | undefined) => void;

export class MessageReceipts<T> {
  private readonly entries = new Map<string, { at: number; result: Promise<T | undefined> }>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `{ prior }` when this key already landed (waiting out an attempt still in flight), else a
   * `settle` the caller MUST call once: with its success response to remember it, or `undefined`
   * when the attempt was refused — a refused key is forgotten, so its retry is judged afresh.
   */
  async claim(key: string): Promise<{ prior: T } | { settle: Settle<T> }> {
    for (;;) {
      this.prune();
      const entry = this.entries.get(key);
      if (!entry) break;
      const prior = await entry.result;
      if (prior !== undefined) return { prior };
    }
    let resolve!: (result: T | undefined) => void;
    const result = new Promise<T | undefined>((r) => (resolve = r));
    this.entries.set(key, { at: this.now(), result });
    return {
      settle: (response) => {
        if (response === undefined) this.entries.delete(key);
        resolve(response);
      },
    };
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      // Map order is insertion order, so the oldest come first.
      if (entry.at >= cutoff && this.entries.size <= this.max) break;
      this.entries.delete(key);
    }
  }
}
