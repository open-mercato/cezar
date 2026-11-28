import { randomBytes } from 'node:crypto';
import { DEFAULT_PHONE_PUSH_PREFS, type AttentionKind, type PhonePushPrefs } from '@open-mercato/cezar-contract';
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
  prefs?: PhonePushPrefs | undefined;
  /** The count this phone was last pushed, kept across restarts. */
  countTold?: number | undefined;
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
  /** Keeps the count a phone was last pushed, so a restart still owes it a lower one. */
  setCountTold?: (deviceId: string, count: number) => void;
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

/** Minutes past midnight in `timeZone`, and the seconds into that minute. */
function zonedClock(now: number, timeZone: string): { minute: number; second: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
    const part = (type: string) => Number(parts.find((each) => each.type === type)?.value);
    const minute = part('hour') * 60 + part('minute');
    return Number.isFinite(minute) ? { minute, second: part('second') || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * When quiet hours that cover `now` end, in epoch ms, or null outside them. Read in the phone's own
 * time zone; a window whose start follows its end spans midnight, and equal ends mean off.
 */
export function quietUntil(quiet: PhonePushPrefs['quiet'], now: number): number | null {
  if (!quiet) return null;
  const start = minutesOf(quiet.from);
  const end = minutesOf(quiet.to);
  if (start === end) return null;
  const clock = zonedClock(now, quiet.timeZone);
  if (!clock) return null;
  const { minute } = clock;
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const left = (end - minute + 1440) % 1440;
  // Minutes on the wall clock: a DST shift inside the window moves the release by up to an hour.
  return now + left * 60_000 - clock.second * 1000 - (now % 1000);
}

const prefsOf = (device: PushGrantRow): PhonePushPrefs => device.prefs ?? DEFAULT_PHONE_PUSH_PREFS;
const wants = (device: PushGrantRow, kinds: ReadonlySet<AttentionKind>): boolean => prefsOf(device).push.some((kind) => kinds.has(kind));

export class RelayPushSink {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSentAt = -Infinity;
  private target: string | undefined;
  /** What the signals since the last flush were about; each phone pushes only for kinds it chose. */
  private kinds = new Set<AttentionKind>();
  /** Phones a signal reached during their quiet hours, with its kinds: one push when the hours end. */
  private held = new Map<string, Set<AttentionKind>>();
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private heldUntil = Infinity;
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
      // Only an app that declared it: a released one shows every data push as an alert.
      if (!prefsOf(device).understands.includes('count')) continue;
      if (!device.push || device.push.expiresAt <= now / 1000 || this.deps.live(device.deviceId)) continue;
      // Owed once the phone knows a number (an alert, or its app opened), and in both directions: a kind
      // counted on the icon but not pushed still moves the icon (spec § Relay change).
      const told = this.told.get(device.deviceId) ?? device.countTold;
      if (told === undefined) continue;
      const count = badgeCount(await this.deps.count(prefsOf(device).icon).catch(() => NaN));
      if (Number.isNaN(count) || count === told) continue;
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

  /**
   * The phone's app just opened and read its counts itself: what it shows now is what it was told, so
   * a later change, up or down, is owed to it (spec § Relay change).
   */
  async noteOpened(deviceId: string): Promise<void> {
    const device = this.deps.devices().find((row) => row.deviceId === deviceId);
    if (!device) return;
    const count = badgeCount(await this.deps.count(prefsOf(device).icon).catch(() => NaN));
    if (Number.isNaN(count)) return;
    this.told.set(deviceId, count);
    this.deps.setCountTold?.(deviceId, count);
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
    const targets: Array<{ device: PushGrantRow; kinds: ReadonlySet<AttentionKind> }> = [];
    let delivered = false;
    for (const device of this.deps.devices()) {
      if (!wants(device, kinds)) continue;
      const quiet = quietUntil(prefsOf(device).quiet, now);
      if (quiet !== null) {
        this.hold(device.deviceId, kinds, quiet);
        continue;
      }
      // One path per phone: its session if it has one, the relay only if it has none.
      if (this.deps.live(device.deviceId)) {
        if (this.deps.deliver?.(device.deviceId, this.target)) delivered = true;
        continue;
      }
      if (device.push) targets.push({ device, kinds });
    }
    if (delivered) this.lastSentAt = now;
    await this.sendAll(targets, now);
  }

  /**
   * Relay pushes, each with its own phone's count. The alert's own kind counts at least 1, so a kind the
   * phone pushes but leaves off its icon (failed tasks, by default) still arrives. The phone is told only
   * its icon count, so no count push takes that alert's badge away again.
   */
  private async sendAll(entries: ReadonlyArray<{ device: PushGrantRow; kinds: ReadonlySet<AttentionKind> }>, now: number): Promise<void> {
    const origin = this.deps.origin();
    const targets: Array<{ device: PushGrantRow; count: number; icon: number }> = [];
    for (const { device, kinds } of entries) {
      if (!device.push) continue;
      // The relay would answer 410 for it; nothing is gained by asking.
      if (device.push.expiresAt <= now / 1000) {
        this.deps.dropGrant(device.deviceId, device.push.grantId);
        continue;
      }
      // Read before the send: an alert about nothing this phone chose would leave a badge nothing clears.
      const icon = badgeCount(await this.deps.count(prefsOf(device).icon).catch(() => 0));
      const count = wants(device, kinds) ? Math.max(1, icon) : icon;
      if (count > 0) targets.push({ device, count, icon });
    }
    if (targets.length === 0 || !origin) return;
    const seed = await this.deps.seed().catch(() => null);
    if (!seed) return;
    this.lastSentAt = now;
    await Promise.all(targets.map(({ device, count, icon }) => this.sendOne(origin, seed, device.deviceId, device.push!, count, 'attention', icon)));
    // A count that changed while the alert was in flight follows as a count push.
    this.noteChange();
  }

  private hold(deviceId: string, kinds: ReadonlySet<AttentionKind>, until: number): void {
    this.held.set(deviceId, new Set([...(this.held.get(deviceId) ?? []), ...kinds]));
    // One timer, at the earliest end: a phone whose quiet hours end sooner re-arms it.
    if (this.heldTimer && until >= this.heldUntil) return;
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldUntil = until;
    this.heldTimer = outsideRelayScope(() => setTimeout(() => {
      this.heldTimer = undefined;
      this.heldUntil = Infinity;
      this.sending = this.releaseHeld().finally(() => { this.sending = undefined; });
    }, Math.max(1_000, until - this.now())));
    this.heldTimer.unref?.();
  }

  /** Quiet hours over: one push to each held phone still waiting on something. Re-holds any still quiet. */
  private async releaseHeld(): Promise<void> {
    if (this.disposed || !this.deps.enabled()) return;
    const now = this.now();
    const held = this.held;
    this.held = new Map();
    const due: Array<{ device: PushGrantRow; kinds: ReadonlySet<AttentionKind> }> = [];
    for (const device of this.deps.devices()) {
      const kinds = held.get(device.deviceId);
      if (!kinds) continue;
      const quiet = quietUntil(prefsOf(device).quiet, now);
      if (quiet !== null) this.hold(device.deviceId, kinds, quiet);
      else if (!this.deps.live(device.deviceId)) due.push({ device, kinds });
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
    /** What the phone's icon counts, when the alert's floor raised `count` above it. */
    told: number = count,
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
    if (status === 202) {
      this.told.set(deviceId, told);
      this.deps.setCountTold?.(deviceId, told);
    }
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
