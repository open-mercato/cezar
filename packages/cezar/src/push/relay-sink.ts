import { randomBytes } from 'node:crypto';
import { DEFAULT_PHONE_NOTIFICATION_PREFS, type AttentionKind, type PhoneNotificationPrefs } from '@open-mercato/cezar-contract';
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
  /** Absent means the defaults (spec 2026-11-20-phone-notifications-inbox). */
  notifications?: PhoneNotificationPrefs | undefined;
}

export type PushPost = (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number; retryAfter?: number }>;

/** Rome allows 6 count pushes per grant per rolling hour (RELAY_PROTOCOL.md § 7): one per 10 minutes stays inside it. */
export const COUNT_MIN_INTERVAL_MS = 10 * 60_000;
/** A change settles before its count goes out, so a burst of answers is one push. */
export const COUNT_DEBOUNCE_MS = 15_000;

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
  /** The badge for one phone: what its counted kinds add up to. Read at send time, never from the signal. */
  count: (badgeKinds: readonly AttentionKind[]) => Promise<number>;
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
  const retryAfter = Number(response.headers.get('retry-after'));
  return { status: response.status, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) };
};

/** Exactly § 7's request. A test pins the key set, so a new field cannot slip in. */
export function pushBody(grant: string, count: number, id: string, ts: number, kind: 'attention' | 'count' = 'attention'): string {
  return JSON.stringify({ v: 1, grant, kind, count, id, ts });
}

/** 0 means nothing this phone counts waits, and no push goes out for it. */
export const badgeCount = (count: number): number => Math.min(99, Math.max(0, Math.floor(Number.isFinite(count) ? count : 0)));

const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/**
 * When quiet hours that cover `now` end, in epoch ms, or null outside them. Local time of this
 * computer; a window whose start follows its end spans midnight, and equal ends mean off.
 */
export function quietUntil(quiet: PhoneNotificationPrefs['quietHours'], now: number): number | null {
  if (!quiet) return null;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return null;
  const at = new Date(now);
  const minute = at.getHours() * 60 + at.getMinutes();
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const until = new Date(now);
  until.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (until.getTime() <= now) until.setDate(until.getDate() + 1);
  return until.getTime();
}

const prefsOf = (device: PushGrantRow): PhoneNotificationPrefs => device.notifications ?? DEFAULT_PHONE_NOTIFICATION_PREFS;
const wants = (device: PushGrantRow, kinds: ReadonlySet<AttentionKind>): boolean => prefsOf(device).push.some((kind) => kinds.has(kind));

export class RelayPushSink {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSentAt = -Infinity;
  private target: string | undefined;
  /** What the signals since the last flush were about; each phone pushes only for kinds it chose. */
  private kinds = new Set<AttentionKind>();
  /** Phones a signal reached during their quiet hours: one push when the hours end, if anything still waits. */
  private held = new Set<string>();
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  /** The count each phone was last told, by an attention or a count push. Unknown after a restart. */
  private told = new Map<string, number>();
  /** Per phone: no count push before this (our 10-minute pace, or the relay's Retry-After). */
  private countNotBefore = new Map<string, number>();
  private countTimer: ReturnType<typeof setTimeout> | undefined;
  /** A relay older than `kind: "count"` answers 400: stop asking it until the next restart. */
  private countUnsupported = false;
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

  /** Arms one send. Further signals before it fires only move the tap target and add their kind. */
  signal(managerId: string, kind: AttentionKind = 'message'): void {
    if (this.disposed || !this.deps.enabled() || !this.hasTargets()) return;
    this.target = managerId;
    this.kinds.add(kind);
    if (this.timer) return;
    const delay = Math.max(PUSH_DEBOUNCE_MS, this.lastSentAt + PUSH_MIN_INTERVAL_MS - this.now());
    this.timer = outsideRelayScope(() => setTimeout(() => {
      this.timer = undefined;
      this.sending = this.flush().finally(() => { this.sending = undefined; });
    }, delay));
    this.timer.unref?.();
  }

  /**
   * What waits changed (answered, approved, read, on any device). Each phone that is not open gets its
   * new count by a silent `count` push, so its icon follows without the app (RELAY_PROTOCOL.md § 7).
   */
  noteChange(): void {
    if (this.disposed || !this.deps.enabled() || this.countUnsupported) return;
    this.armCounts(this.now() + COUNT_DEBOUNCE_MS);
  }

  private armCounts(at: number): void {
    if (this.countTimer) return;
    this.countTimer = outsideRelayScope(() => setTimeout(() => {
      this.countTimer = undefined;
      const run = this.flushCounts();
      this.sending = (this.sending ? this.sending.then(() => run) : run).finally(() => { this.sending = undefined; });
    }, Math.max(1_000, at - this.now())));
    this.countTimer.unref?.();
  }

  private async flushCounts(): Promise<void> {
    if (this.disposed || !this.deps.enabled()) return;
    const origin = this.deps.origin();
    if (!origin) return;
    const now = this.now();
    let later: number | undefined;
    const due: Array<{ device: PushGrantRow; count: number }> = [];
    for (const device of this.deps.devices()) {
      // An open app reads its counts itself; an expired grant would only earn a 410.
      if (!device.push || device.push.expiresAt <= now / 1000 || this.deps.live(device.deviceId)) continue;
      const count = badgeCount(await this.deps.count(prefsOf(device).badge).catch(() => NaN));
      if (Number.isNaN(count) || this.told.get(device.deviceId) === count) continue;
      const notBefore = this.countNotBefore.get(device.deviceId) ?? 0;
      if (notBefore > now) {
        later = Math.min(later ?? notBefore, notBefore);
        continue;
      }
      due.push({ device, count });
    }
    if (later !== undefined) this.armCounts(later);
    if (due.length === 0) return;
    const seed = await this.deps.seed().catch(() => null);
    if (!seed) return;
    await Promise.all(due.map(async ({ device, count }) => {
      this.countNotBefore.set(device.deviceId, now + COUNT_MIN_INTERVAL_MS);
      const answer = await this.sendOne(origin, seed, device.deviceId, device.push!, count, 'count');
      if (answer?.status === 400) this.countUnsupported = true;
      if (answer?.status === 429) {
        // Coalesced: the retry reads the count again, so only the latest one goes, with a new id.
        const at = this.now() + (answer.retryAfter ?? COUNT_MIN_INTERVAL_MS / 1000) * 1000;
        this.countNotBefore.set(device.deviceId, at);
        this.armCounts(at);
      }
    }));
  }

  /** Tests wait on this; nothing else needs to. */
  idle(): Promise<void> {
    return this.sending ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heldTimer) clearTimeout(this.heldTimer);
    if (this.countTimer) clearTimeout(this.countTimer);
    this.countTimer = undefined;
    this.timer = undefined;
    this.heldTimer = undefined;
  }

  private hasTargets(): boolean {
    return this.deps.hasStreams?.() === true || this.deps.devices().some((device) => device.push !== undefined);
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.deps.enabled()) return;
    const kinds = this.kinds;
    this.kinds = new Set();
    const now = this.now();
    const targets: PushGrantRow[] = [];
    let delivered = false;
    for (const device of this.deps.devices()) {
      if (!wants(device, kinds)) continue;
      const quiet = quietUntil(prefsOf(device).quietHours, now);
      if (quiet !== null) {
        this.hold(device.deviceId, quiet);
        continue;
      }
      // One path per phone: its session if it has one, the relay only if it has none.
      if (this.deps.live(device.deviceId)) {
        if (this.deps.deliver?.(device.deviceId, this.target)) delivered = true;
        continue;
      }
      if (device.push) targets.push(device);
    }
    if (delivered) this.lastSentAt = now;
    await this.sendAll(targets, now);
  }

  /** Relay pushes, each with its own phone's count; a phone whose count is 0 gets none. */
  private async sendAll(devices: readonly PushGrantRow[], now: number): Promise<void> {
    const origin = this.deps.origin();
    const targets: Array<{ device: PushGrantRow; count: number }> = [];
    for (const device of devices) {
      if (!device.push) continue;
      // The relay would answer 410 for it; nothing is gained by asking.
      if (device.push.expiresAt <= now / 1000) {
        this.deps.dropGrant(device.deviceId, device.push.grantId);
        continue;
      }
      // Read before the send: a push for what this phone does not count would leave a badge nothing clears.
      const count = badgeCount(await this.deps.count(prefsOf(device).badge).catch(() => 0));
      if (count > 0) targets.push({ device, count });
    }
    if (targets.length === 0 || !origin) return;
    const seed = await this.deps.seed().catch(() => null);
    if (!seed) return;
    this.lastSentAt = now;
    await Promise.all(targets.map(({ device, count }) => this.sendOne(origin, seed, device.deviceId, device.push!, count)));
    // A count that changed while the alert was in flight follows as a count push.
    this.noteChange();
  }

  private hold(deviceId: string, until: number): void {
    this.held.add(deviceId);
    if (this.heldTimer) return;
    this.heldTimer = outsideRelayScope(() => setTimeout(() => {
      this.heldTimer = undefined;
      this.sending = this.releaseHeld().finally(() => { this.sending = undefined; });
    }, Math.max(1_000, until - this.now())));
    this.heldTimer.unref?.();
  }

  /** Quiet hours over: one push to each held phone still waiting on something. Re-holds any still quiet. */
  private async releaseHeld(): Promise<void> {
    if (this.disposed || !this.deps.enabled()) return;
    const now = this.now();
    const held = this.held;
    this.held = new Set();
    const due: PushGrantRow[] = [];
    for (const device of this.deps.devices()) {
      if (!held.has(device.deviceId)) continue;
      const quiet = quietUntil(prefsOf(device).quietHours, now);
      if (quiet !== null) this.hold(device.deviceId, quiet);
      else if (!this.deps.live(device.deviceId)) due.push(device);
    }
    await this.sendAll(due, now);
  }

  private async sendOne(
    origin: string,
    seed: Buffer,
    deviceId: string,
    push: NonNullable<PushGrantRow['push']>,
    count: number,
    kind: 'attention' | 'count' = 'attention',
  ): Promise<{ status: number; retryAfter?: number } | undefined> {
    const ts = Math.floor(this.now() / 1000);
    // A fresh id every time: the relay remembers a count push's id for an hour.
    const body = Buffer.from(pushBody(push.grant, count, b64u(randomBytes(16)), ts, kind), 'utf8');
    let answer: { status: number; retryAfter?: number };
    try {
      answer = await this.post(`${origin}${PUSH_PATH}`, { headers: { ...proofHeaders(seed, postProof(PUSH_PATH, body, ts), ts) }, body });
    } catch {
      return undefined; // Best effort, § 7: the card waits in the chat.
    }
    const { status } = answer;
    if (status === 202) this.told.set(deviceId, count);
    if (status === 403 || status === 410) {
      this.deps.dropGrant(deviceId, push.grantId);
      return answer;
    }
    // A bug or a clock problem, never retried. The line names no grant, token or device.
    if (kind === 'count' && status === 400) {
      if (!this.countUnsupported) this.deps.warn?.('[cezar] the relay does not take count pushes yet; phone badges update when the app opens');
      return answer;
    }
    if (status === 400 || status === 401) this.deps.warn?.(`[cezar] the relay refused a push (${status})`);
    return answer;
  }
}
