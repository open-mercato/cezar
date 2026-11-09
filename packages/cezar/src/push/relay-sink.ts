import { randomBytes } from 'node:crypto';
import { outsideRelayScope } from '../relay/scope.ts';
import { b64u, proofHeaders, postProof } from '../relay/wire.ts';

/**
 * The relay output of the push sink (spec 2026-11-01-relay-qr-pairing, R5; RELAY_PROTOCOL.md § 7).
 * A signal carries no text by construction: the request has six fixed fields, and what a manager
 * said never reaches this module, only that one wants the user.
 */

/** A burst of alerts is one push, and cezar itself sends at most one a minute (spec, Abuse controls). */
export const PUSH_DEBOUNCE_MS = 10_000;
export const PUSH_MIN_INTERVAL_MS = 60_000;
const PUSH_TIMEOUT_MS = 15_000;
export const PUSH_PATH = '/v1/push';

export interface PushGrantRow {
  deviceId: string;
  push?: { grant: string; grantId: string; expiresAt: number } | undefined;
}

export type PushPost = (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number }>;

export interface RelayPushSinkDeps {
  /** `CEZ_PUSH=0` turns the whole sink off. */
  enabled: () => boolean;
  origin: () => string | null;
  /** cezar's Ed25519 seed, or `null` when no identity exists yet. */
  seed: () => Promise<Buffer | null>;
  devices: () => readonly PushGrantRow[];
  /** A proven session: the app is open, or just left it and its socket has not closed yet. */
  live: (deviceId: string) => boolean;
  /**
   * Stage 1: hands the signal to the phone's open in-session stream, so the phone can raise a local
   * notification. False when it has none. A live phone never also gets a relay push: no double notify.
   */
  deliver?: (deviceId: string, managerId: string | undefined) => boolean;
  /** Some phone has a signal stream open, so a signal is worth arming with no push grant at all. */
  hasStreams?: () => boolean;
  /** 403 and 410 only, § 7. */
  dropGrant: (deviceId: string, grantId: string) => void;
  /** The badge. Read at send time, never from the signal. */
  count: () => Promise<number>;
  post?: PushPost;
  now?: () => number;
  warn?: (line: string) => void;
}

const defaultPost: PushPost = async (url, { headers, body }) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status };
};

/** Exactly § 7's request. A test pins the key set, so a new field cannot slip in. */
export function pushBody(grant: string, count: number, id: string, ts: number): string {
  return JSON.stringify({ v: 1, grant, kind: 'attention', count, id, ts });
}

export const badgeCount = (count: number): number => Math.min(99, Math.max(1, Math.floor(Number.isFinite(count) ? count : 1)));

export class RelayPushSink {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSentAt = -Infinity;
  private target: string | undefined;
  private sending: Promise<void> | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly post: PushPost;

  constructor(private readonly deps: RelayPushSinkDeps) {
    this.now = deps.now ?? Date.now;
    this.post = deps.post ?? defaultPost;
  }

  /** The manager the latest push was about, read by the phone inside its session for the tap. */
  latestManager(): string | undefined {
    return this.target;
  }

  /** Arms one send. Further signals before it fires only move the tap target. */
  signal(managerId: string): void {
    if (this.disposed || !this.deps.enabled() || !this.hasTargets()) return;
    this.target = managerId;
    if (this.timer) return;
    const delay = Math.max(PUSH_DEBOUNCE_MS, this.lastSentAt + PUSH_MIN_INTERVAL_MS - this.now());
    this.timer = outsideRelayScope(() => setTimeout(() => {
      this.timer = undefined;
      this.sending = this.flush().finally(() => { this.sending = undefined; });
    }, delay));
    this.timer.unref?.();
  }

  /** Tests wait on this; nothing else needs to. */
  idle(): Promise<void> {
    return this.sending ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private hasTargets(): boolean {
    return this.deps.hasStreams?.() === true || this.deps.devices().some((device) => device.push !== undefined);
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.deps.enabled()) return;
    const origin = this.deps.origin();
    const nowSeconds = this.now() / 1000;
    const targets: PushGrantRow[] = [];
    let delivered = false;
    for (const device of this.deps.devices()) {
      // One path per phone: its session if it has one, the relay only if it has none.
      if (this.deps.live(device.deviceId)) {
        if (this.deps.deliver?.(device.deviceId, this.target)) delivered = true;
        continue;
      }
      if (!device.push) continue;
      // The relay would answer 410 for it; nothing is gained by asking.
      if (device.push.expiresAt <= nowSeconds) this.deps.dropGrant(device.deviceId, device.push.grantId);
      else targets.push(device);
    }
    if (delivered) this.lastSentAt = this.now();
    if (targets.length === 0 || !origin) return;
    const seed = await this.deps.seed().catch(() => null);
    if (!seed) return;
    this.lastSentAt = this.now();
    const count = badgeCount(await this.deps.count().catch(() => 1));
    await Promise.all(targets.map((device) => this.sendOne(origin, seed, device.deviceId, device.push!, count)));
  }

  private async sendOne(origin: string, seed: Buffer, deviceId: string, push: NonNullable<PushGrantRow['push']>, count: number): Promise<void> {
    const ts = Math.floor(this.now() / 1000);
    const body = Buffer.from(pushBody(push.grant, count, b64u(randomBytes(16)), ts), 'utf8');
    let status: number;
    try {
      ({ status } = await this.post(`${origin}${PUSH_PATH}`, { headers: { ...proofHeaders(seed, postProof(PUSH_PATH, body, ts), ts) }, body }));
    } catch {
      return; // Best effort, § 7: the card waits in the chat.
    }
    if (status === 403 || status === 410) {
      this.deps.dropGrant(deviceId, push.grantId);
      return;
    }
    // A bug or a clock problem, never retried. The line names no grant, token or device.
    if (status === 400 || status === 401) this.deps.warn?.(`[cezar] the relay refused a push (${status})`);
  }
}
