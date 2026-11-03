import { z } from 'zod';
import { TelegramApiError, type TelegramCall } from './client.ts';
import { telegramUpdateSchema, type TelegramUpdate } from './protocol.ts';
import type { InboundStateStore } from './state.ts';

export type PollerHealth = { state: 'stopped' | 'polling' | 'backoff' | 'conflict' | 'credentials-unavailable' | 'blocked'; lastSuccessfulPollAt?: number };
const batchSchema = z.array(z.object({ update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) }).passthrough()).max(50);
function retryable(error: TelegramApiError): boolean {
  return error.code === 'network' || error.code === 'dns_not_found' || error.status === 429 || (error.status !== undefined && error.status >= 500);
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, Math.min(ms, 60_000));
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One loop per leased bot; only the durable offset is sent to Telegram. */
export class TelegramPoller {
  private controller?: AbortController;
  private running?: Promise<void>;
  private current: PollerHealth = { state: 'stopped' };
  constructor(private readonly deps: {
    call: TelegramCall; store: InboundStateStore;
    process(update: TelegramUpdate, epoch: string): Promise<void>;
    needed(): boolean;
    assertCredentials(): Promise<void>;
    onHealth?(health: PollerHealth): void;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    allowedUpdates?: readonly string[];
  }) {}
  health(): PollerHealth { return { ...this.current }; }
  start(): void {
    if (this.running) return;
    const controller = new AbortController(); this.controller = controller;
    this.running = this.loop(controller.signal).finally(() => { this.running = undefined; });
  }
  async stop(): Promise<void> { this.controller?.abort(); await this.running; this.setHealth('stopped'); }
  private setHealth(state: PollerHealth['state'], successfulAt?: number): void {
    this.current = { ...this.current, state, ...(successfulAt === undefined ? {} : { lastSuccessfulPollAt: successfulAt }) };
    this.deps.onHealth?.(this.health());
  }
  private async loop(signal: AbortSignal): Promise<void> {
    const now = this.deps.now ?? Date.now;
    let failures = 0, limit = 50, retryAt = 0;
    try {
      await this.deps.store.recover();
      while (!signal.aborted && this.deps.needed()) {
        this.deps.store.assertReady();
        if (retryAt > now()) { await (this.deps.wait ?? pause)(retryAt - now(), signal); continue; }
        try {
          try { await this.deps.assertCredentials(); } catch { this.setHealth('credentials-unavailable'); return; }
          if (signal.aborted || !this.deps.needed()) break;
          await this.deps.store.preparePoll(now());
          const snapshot = this.deps.store.snapshot();
          this.setHealth('polling');
          const raw = await this.deps.call('getUpdates', { timeout: 25, limit, allowed_updates: this.deps.allowedUpdates ?? ['message'],
            ...(snapshot.nextOffset === null ? {} : { offset: snapshot.nextOffset }) }, signal);
          if (signal.aborted) break;
          this.deps.store.assertReady();
          const batch = batchSchema.parse(raw);
          // Telegram orders updates; fail closed on an invalid batch rather than acknowledging unseen data.
          if (batch.some((update, index) => index > 0 && update.update_id <= batch[index - 1]!.update_id)) throw new Error('Unordered update batch');
          this.setHealth('polling', now()); failures = 0; limit = 50;
          if (batch.length) await this.deps.store.touch(now());
          try {
            for (const rawUpdate of batch) {
              if (signal.aborted || !this.deps.needed()) break;
              if (this.deps.store.duplicate(snapshot.epoch, rawUpdate.update_id)) continue;
              const update = telegramUpdateSchema.safeParse(rawUpdate);
              if (update.success) await this.deps.process(update.data, snapshot.epoch);
              else await this.deps.store.finish(snapshot.epoch, rawUpdate.update_id);
            }
          } finally {
            // One durable write per batch for ignored/stranger updates; Telegram replays an unflushed tail.
            if (batch.length) await this.deps.store.flush();
          }
        } catch (error) {
          if (signal.aborted) break;
          this.deps.store.assertReady();
          if (!(error instanceof TelegramApiError)) { this.setHealth('blocked'); return; }
          if (error.code === 'body_limit') {
            if (limit === 1) { this.setHealth('blocked'); return; }
            limit = 1; continue;
          }
          if (error.status === 401) { this.setHealth('credentials-unavailable'); return; }
          if (error.status === 409) { this.setHealth('conflict'); return; }
          if (!retryable(error)) {
            this.setHealth('blocked'); return;
          }
          failures++;
          const delay = error.status === 429 ? (error.retryAfter ?? 5) * 1000
            : Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) * (0.8 + Math.random() * 0.2);
          retryAt = now() + delay; this.setHealth('backoff');
        }
      }
      this.setHealth('stopped');
    } catch { if (!signal.aborted) this.setHealth('blocked'); }
  }
}
