import type { InputUpdate } from './events.ts';
import type { ChatFailure } from './provider.ts';
/** `polling` means receiving, on any transport. */
/** `connecting` marks a `stopped` bot whose runtime is live but not connected yet, so it is not shown as not running. */
export type ChatHealth = { state: 'stopped' | 'polling' | 'backoff' | 'conflict' | 'credentials-unavailable' | 'blocked'; lastSuccessfulPollAt?: number; connecting?: true };
export interface ChatConnection { start(): void; stop(): Promise<void>; health(): ChatHealth }
export interface ChatConnectionOptions {
  accept(event: import('./provider.ts').ChatEvent): Promise<void>;
  process(update: InputUpdate, epoch: string): Promise<void>;
  needed(): boolean;
  assertCredentials(): Promise<void>;
  onHealth(health: ChatHealth): void;
  /** Optional provider-native command hooks. Providers must map execution back into ChatEvent semantics. */
  nativeCommands?: {
    tasks(query: string, chatId: string, userId: string): Promise<readonly { name: string; value: string }[]>;
  };
}
export type ChatConnect = (options: ChatConnectionOptions) => ChatConnection;
/** The receive adapter can checkpoint and deduplicate, but cannot inspect grants, sources or runs. */
export interface ReceiveJournal {
 recover(): Promise<void>; assertReady(): void | Promise<void>; prepareReceive(now: number, idleResetMs?: number): Promise<void>;
 snapshot(): { epoch: string; nextOffset: number | null } | Promise<{ epoch: string; nextOffset: number | null }>;
 duplicate(epoch: string, sequence: number): boolean | Promise<boolean>;
 finish(epoch: string, sequence: number): Promise<void>;
 touch(at: number): Promise<void>; flush(): Promise<void>;
}

/** A rate limit waits what it asks for; a transient failure backs off exponentially. Both are
 *  capped at 60 s, so a persistently broken transport costs one attempt a minute. */
export function receiveRetryDelay(failure: ChatFailure, attempt: number): number {
  if (failure.kind === 'rate_limited') return Math.max(1000, Math.min(60_000, failure.retryAfterMs ?? 1000));
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}
