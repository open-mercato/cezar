import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { PhonePairingCodeResponse, PhonePushState, PhonesResponse, RelayStatus, SetPhonePushGrantInput, StartPhonePairingResponse, TestRelayAddressResponse } from '@open-mercato/cezar-contract';
import { RelayPushSink, type PushPost } from '../push/relay-sink.ts';
import { cezarHomeDir } from '../paths.ts';
import { loadWorkspaceConfigOrThrow, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { RelayCommandError, RelayConnection, COMMAND_TIMEOUT_MS } from './connection.ts';
import { RelayDevices, type PendingRemoval } from './devices.ts';
import { RelayIdentityStore, RelayKeysLocked, type RelayIdentity } from './identity.ts';
import { Pairing, PairingStartError } from './pairing.ts';
import { probeRelay } from './probe.ts';
import type { PairedPhone } from './rendezvous.ts';
import { outsideRelayScope, runInRelayScope } from './scope.ts';
import { PhoneSession } from './session.ts';
import { openWebSocket, type SocketFactory } from './socket.ts';
import { CLOSE, DEFAULT_RELAY_ORIGIN, b64u, fromB64u, parseRelayOrigin, resolveRelayAddress, type RelayAddress } from './wire.ts';

export const PAIRINGS_PER_HOUR = 5;
const INVALID_ADDRESS = 'Use https://host, or http:// only for 127.0.0.1, localhost or [::1], with no path.';
const HOUR_MS = 3_600_000;
const SOCKET_READY_MS = 8_000;
/** How long a new address waits for the old relay, so a dead one cannot hold the Save. */
const LEAVE_RELAY_MS = 5_000;

/** Where the address from Settings lives. Tests replace it; everything else uses `config.json`. */
export interface RelayAddressStore {
  read(): Promise<string | null>;
  write(address: string | null): Promise<void>;
}

const workspaceAddressStore: RelayAddressStore = {
  read: async () => (await loadWorkspaceConfigOrThrow()).relayAddress ?? null,
  write: async (address) => {
    await mergeWriteWorkspaceConfig((config) => {
      if (address === null) delete config.relayAddress;
      else config.relayAddress = address;
    });
  },
};

export class RelayAddressError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

export interface RelayServiceOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  open?: SocketFactory;
  identity?: RelayIdentityStore;
  label?: string;
  now?: () => number;
  addressStore?: RelayAddressStore;
  /** The push transport; tests pass a fake, everything else uses `fetch`. */
  pushPost?: PushPost;
}

/** `CEZ_PUSH=0` (parent spec Q9): no grant is taken and nothing is sent. */
export const pushBlocked = (env: NodeJS.ProcessEnv = process.env): boolean => env.CEZ_PUSH === '0';

const truncateBytes = (text: string, limit: number): string => {
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > limit) out = out.slice(0, -1);
  return out;
};

/**
 * Everything a paired phone needs from `cezar serve` (spec 2026-11-01-relay-qr-pairing). Inert until
 * asked: the constructor touches no disk, and with no device there is no socket.
 */
export class RelayService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly open: SocketFactory;
  private readonly directory: string;
  private readonly identityStore: RelayIdentityStore;
  private readonly devices: RelayDevices;
  private readonly label: string;
  private readonly now: () => number;
  private onChange: () => void = () => {};
  private connection: RelayConnection | undefined;
  private identity: RelayIdentity | undefined;
  private status: RelayStatus = 'off';
  private detail: string | undefined;
  private pairing: Pairing | undefined;
  private pairingStarts: number[] = [];
  private readonly slots = new Set<string>();
  private readonly sessions = new Map<string, PhoneSession>();
  private fetcher: ((request: Request) => Promise<Response>) | undefined;
  private disposed = false;
  private readonly addressStore: RelayAddressStore;
  private savedAddress: string | null = null;
  private addressLoaded = false;
  private addressWrites = 0;
  private changingAddress = false;
  /** Never the real identity: Test must not tell a relay nobody chose yet who this computer is. */
  private readonly probeSeed = randomBytes(32);
  private readonly push: RelayPushSink;
  /** Each phone's open `GET /workspace/phone/signals` streams (stage 1), ended with its session. */
  private readonly signalStreams = new Map<string, Set<(managerId: string | undefined) => void>>();
  private pushCount: () => Promise<number> = async () => 1;

  constructor(options: RelayServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.open = options.open ?? openWebSocket;
    this.directory = options.directory ?? join(cezarHomeDir(this.env), 'relay');
    this.identityStore = options.identity ?? new RelayIdentityStore(this.directory);
    this.devices = new RelayDevices(this.directory);
    this.label = options.label ?? (truncateBytes(hostname(), 64) || 'Computer');
    this.now = options.now ?? Date.now;
    this.addressStore = options.addressStore ?? workspaceAddressStore;
    this.push = new RelayPushSink({
      enabled: () => !pushBlocked(this.env),
      origin: () => this.origin,
      seed: async () => (this.identity ?? (await this.identityStore.load()))?.edSeed ?? null,
      devices: () => this.devices.list(),
      live: (deviceId) => this.sessions.get(deviceId)?.proven === true,
      deliver: (deviceId, managerId) => {
        const streams = this.signalStreams.get(deviceId);
        if (!streams || streams.size === 0) return false;
        for (const send of streams) send(managerId);
        return true;
      },
      hasStreams: () => [...this.signalStreams.values()].some((streams) => streams.size > 0),
      dropGrant: (deviceId, grantId) => {
        try {
          if (this.devices.clearPush(deviceId, grantId)) this.onChange();
        } catch {
          // A read-only home sends to a dead grant again, and the relay refuses it again.
        }
      },
      count: () => this.pushCount(),
      ...(options.pushPost ? { post: options.pushPost } : {}),
      now: this.now,
      warn: (line) => console.warn(line),
    });
  }

  /** The badge: the server's own total of what waits on the user. */
  attachPush(count: () => Promise<number>): void {
    this.pushCount = count;
  }

  /** A manager wants the user. Carries the manager id for the tap, never what it said. */
  signalPush(managerId: string): void {
    this.push.signal(managerId);
  }

  /**
   * Stage 1 (spec R5): while this stream is open, the phone's signals come here and never through
   * the relay. `null` for a device with no row or under `CEZ_PUSH=0`. Returns the unsubscribe.
   */
  openSignalStream(deviceId: string, send: (managerId: string | undefined) => void): (() => void) | null {
    if (pushBlocked(this.env) || !this.devices.get(deviceId)) return null;
    const streams = this.signalStreams.get(deviceId) ?? new Set();
    streams.add(send);
    this.signalStreams.set(deviceId, streams);
    return () => {
      streams.delete(send);
      if (streams.size === 0 && this.signalStreams.get(deviceId) === streams) this.signalStreams.delete(deviceId);
    };
  }

  /** Tests only. */
  pushIdle(): Promise<void> {
    return this.push.idle();
  }

  /** Wired once the app exists: dispatched requests enter through `fetcher`. */
  attach(fetcher: (request: Request) => Promise<Response>, onChange: () => void): void {
    this.fetcher = fetcher;
    this.onChange = onChange;
  }

  private get address(): RelayAddress {
    return resolveRelayAddress(this.env, this.savedAddress);
  }

  private get origin(): string | null {
    return this.address.origin;
  }

  /** A config that cannot be read is not "no address": the default would be a relay nobody named. */
  private get addressKnown(): boolean {
    return this.addressLoaded || this.address.source === 'env';
  }

  /** Reconnects at boot only if there is something to do. Never fails boot. */
  async start(): Promise<void> {
    await this.refreshAddress();
    const origin = this.origin;
    if (!origin || this.disposed) return;
    const idle = () => this.devices.list().length === 0 && this.devices.pendingRemovals().length === 0;
    try {
      if (idle()) return;
      if (!this.addressKnown) {
        this.setStatus('error', 'could not read the saved relay address, so fix ~/.cezar/config.json and restart cezar');
        return;
      }
      const identity = await this.identityStore.load();
      // A keychain prompt can outlast a save, and that save left this relay.
      if (this.origin !== origin || idle()) return;
      if (!identity) {
        this.setStatus('error', 'the keys for this computer are gone, so pair your phones again');
        return;
      }
      this.identity = identity;
      this.ensureConnection(identity);
    } catch (error) {
      if (error instanceof RelayKeysLocked) this.setStatus('locked', 'unlock the keychain, then restart cezar');
      else this.setStatus('error', 'could not read the relay keys');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.push.dispose();
    this.pairing?.dispose();
    this.pairing = undefined;
    for (const session of [...this.sessions.values()]) session.drop();
    this.connection?.stop();
    this.connection = undefined;
  }

  private setStatus(status: RelayStatus, detail?: string): void {
    this.status = status;
    this.detail = detail;
    this.onChange();
  }

  private ensureConnection(identity: RelayIdentity): RelayConnection {
    if (this.connection) {
      this.connection.start();
      return this.connection;
    }
    const origin = this.origin;
    if (!origin) throw new Error('relay is off');
    this.connection = new RelayConnection({
      origin,
      identity,
      open: this.open,
      syncDevices: () => this.devices.list().map((device) => ({ device: device.deviceId, key: device.relayKey })),
      onUp: (phones) => this.onUp(phones),
      onDown: () => this.onDown(),
      onPhoneJoined: (deviceId) => this.onPhoneJoined(deviceId),
      onPhoneLeft: (deviceId) => this.onPhoneLeft(deviceId),
      onData: (deviceId, ciphertext) => this.onData(deviceId, ciphertext),
      onStatus: (status, detail) => this.setStatus(status, detail),
    });
    this.connection.start();
    return this.connection;
  }

  private onUp(phones: string[]): void {
    this.slots.clear();
    for (const phone of phones) this.slots.add(phone);
    for (const removal of this.devices.pendingRemovals()) void this.sendRemoval(removal);
  }

  /** A session never outlives its socket, § 10.1. */
  private onDown(): void {
    this.slots.clear();
    for (const session of [...this.sessions.values()]) session.drop();
  }

  private onPhoneJoined(deviceId: string): void {
    this.sessions.get(deviceId)?.drop();
    this.slots.add(deviceId);
  }

  private onPhoneLeft(deviceId: string): void {
    this.slots.delete(deviceId);
    this.sessions.get(deviceId)?.drop();
  }

  private onData(deviceId: string, ciphertext: Buffer): void {
    const session = this.sessions.get(deviceId);
    if (session) {
      session.receive(ciphertext);
      return;
    }
    // One first message per slot, and nothing for a device with no row, § 10. A stale frame from
    // an ended session can land here, so only a first message that decrypts uses the slot up.
    if (!this.slots.has(deviceId)) return;
    const device = this.devices.get(deviceId);
    const noiseKey = device ? fromB64u(device.noiseKey, 32) : null;
    const identity = this.identity;
    if (!device || !noiseKey || !identity) return;
    const accepted = PhoneSession.accept(ciphertext, { cezarId: identity.cezarId, x25519Secret: identity.x25519Secret, deviceNoiseKey: noiseKey }, {
      deviceId,
      send: (bytes) => this.connection?.sendData(deviceId, bytes),
      frameBytes: () => this.connection?.limits.frameBytes ?? 0,
      frameSlot: () => this.connection?.frameSlot() ?? Promise.resolve(),
      fetch: (request) => this.dispatch(deviceId, request),
      onProven: () => this.onSessionProven(deviceId),
      onEnd: (reason) => this.onSessionEnd(deviceId, reason),
    });
    if (!accepted) return;
    this.slots.delete(deviceId);
    this.sessions.set(deviceId, accepted);
  }

  /** `KK` message 1 can be replayed, so only a decrypted `HELLO` counts as the phone being there. */
  private onSessionProven(deviceId: string): void {
    this.touch(deviceId);
    this.onChange();
  }

  private dispatch(deviceId: string, request: Request): Promise<Response> {
    if (!this.fetcher) return Promise.reject(new Error('the cockpit is not ready'));
    const fetcher = this.fetcher;
    return runInRelayScope({ deviceId }, () => fetcher(request));
  }

  private onSessionEnd(deviceId: string, reason: 'closed' | 'goodbye'): void {
    const proven = this.sessions.get(deviceId)?.proven === true;
    this.sessions.delete(deviceId);
    if (reason === 'goodbye') {
      this.dropDevice(deviceId);
      return;
    }
    if (!proven) return;
    this.touch(deviceId);
    this.onChange();
  }

  /** Runs on a socket callback, so a read-only home costs a stale "seen", never the process. */
  private touch(deviceId: string): void {
    try {
      this.devices.update(deviceId, { lastSeenAt: new Date(this.now()).toISOString() });
    } catch {
      // The row is still right in memory.
    }
  }

  /**
   * The row goes first: from here the phone cannot start a session, whatever the relay does. A
   * rolled-back pairing reaches this with a session up, because `commit` saves before its `ack`.
   */
  private dropDevice(deviceId: string): boolean {
    const session = this.sessions.get(deviceId);
    const endSession = () => {
      session?.close(CLOSE.deviceRemoved);
      this.sessions.delete(deviceId);
    };
    let removal: PendingRemoval | undefined;
    try {
      removal = this.devices.remove(deviceId);
    } catch {
      // No caller can answer a failed write. The removal stays in memory for the next connect.
      endSession();
      this.onChange();
      return true;
    }
    if (!removal) return false;
    endSession();
    void this.sendRemoval(removal);
    this.onChange();
    return true;
  }

  private async sendRemoval(removal: PendingRemoval): Promise<void> {
    let connection: RelayConnection | undefined;
    try {
      connection = this.connection ?? (this.identity ? this.ensureConnection(this.identity) : undefined);
      if (!connection) return;
      await connection.whenReady(SOCKET_READY_MS);
      const undenied: string[] = [];
      for (const frame of removalFrames(removal, connection.limits.controlBytes)) {
        try {
          await connection.command(frame);
        } catch (error) {
          // The phone WAS removed; its grants were not denied, and resending would not help.
          if (!(error instanceof RelayCommandError && error.code === 'too-many-grants')) throw error;
          undenied.push(...(frame.grants ?? []));
        }
      }
      this.devices.settleRemoval(removal.deviceId, undenied);
    } catch {
      return; // Kept, and sent again after the next connect.
    }
    this.closeIfIdle();
  }

  /**
   * Read per request, so a save needs no restart and every `cezar serve` on this home converges.
   * A socket never outlives its address: left open, a reconnect would list new phones to a relay
   * the user left. Whoever saved told that relay, so this one only closes. A failed read moves nothing.
   */
  async refreshAddress(): Promise<void> {
    const writes = this.addressWrites;
    let saved: string | null;
    try {
      saved = await this.addressStore.read();
    } catch {
      return; // What it knew stands. The relay never fails a request or the boot.
    }
    if (this.changingAddress || writes !== this.addressWrites) return;
    const before = this.origin;
    const loaded = this.addressLoaded;
    this.savedAddress = saved;
    this.addressLoaded = true;
    if (!loaded || this.origin === before) return;
    this.pairing?.cancel();
    this.connection?.stop();
    this.connection = undefined;
    if (this.devices.list().length > 0) this.setStatus('error', 'the relay address changed, so pair these phones again or restart cezar');
    this.onChange();
  }

  /**
   * The rows go first: past this point no phone can start a session, and a failed save has cost
   * what the user already agreed to. The identity stays, because it is this home's and not the
   * relay's: `cezarId`, both keys and any Manual push grant keep working on the new address.
   */
  setAddress(address: string | null, dropPhones: boolean): Promise<void> {
    return outsideRelayScope(async () => {
      if (this.address.source === 'env' || this.address.source === 'env-invalid') {
        throw new RelayAddressError('CEZ_RELAY_URL sets the relay address, so it cannot be changed here.', 409);
      }
      const origin = address === null ? null : parseRelayOrigin(address);
      if (address !== null && !origin) throw new RelayAddressError(INVALID_ADDRESS, 400);
      await this.refreshAddress();
      if (this.changingAddress) throw new RelayAddressError('The relay address is already changing.', 409);
      // Naming the default is not choosing, so a later default still reaches this user.
      const saved = origin === DEFAULT_RELAY_ORIGIN ? null : origin;
      if ((saved ?? DEFAULT_RELAY_ORIGIN) === this.origin) return;
      if (this.devices.list().length > 0 && !dropPhones) {
        throw new RelayAddressError('Paired phones must pair again after this change, so confirm it first.', 409);
      }
      if (this.pairing && !this.pairing.canReplace) throw new RelayAddressError('A phone is waiting for your answer.', 409);
      this.changingAddress = true;
      try {
        this.pairing?.cancel();
        let removals: PendingRemoval[];
        try {
          removals = this.devices.forgetAll();
        } catch {
          throw new RelayAddressError('Could not update the phone list, so nothing changed.', 409);
        }
        try {
          await this.addressStore.write(saved);
          this.addressWrites += 1;
          this.savedAddress = saved;
        } catch {
          throw new RelayAddressError('Could not save the relay address.', 409);
        } finally {
          await this.leaveRelay(removals);
        }
      } finally {
        this.changingAddress = false;
      }
      this.onChange();
    });
  }

  /** Clean on the old relay when it answers, bounded when it does not. It is only a cost filter. */
  private async leaveRelay(removals: readonly PendingRemoval[]): Promise<void> {
    for (const session of [...this.sessions.values()]) session.close(CLOSE.deviceRemoved);
    const connection = this.connection;
    const undelivered = new Set(removals);
    if (connection?.ready) {
      const told = removals.map(async (removal) => {
        await connection.whenReady(LEAVE_RELAY_MS);
        for (const frame of removalFrames(removal, connection.limits.controlBytes)) await connection.command(frame, LEAVE_RELAY_MS);
        undelivered.delete(removal);
      });
      await Promise.race([
        Promise.allSettled(told),
        new Promise((resolve) => { setTimeout(resolve, LEAVE_RELAY_MS).unref?.(); }),
      ]);
    }
    for (const removal of undelivered) {
      try {
        if (removal.grants.length > 0) this.devices.settleRemoval(removal.deviceId, removal.grants);
      } catch {
        // Grants lapse on their own within 90 days.
      }
    }
    this.connection = undefined;
    connection?.stop();
    this.setStatus('off');
  }

  /** Touches no device row and no saved state, and runs only on the user's click. */
  testAddress(address: string): Promise<TestRelayAddressResponse> {
    return outsideRelayScope(async (): Promise<TestRelayAddressResponse> => {
      const origin = parseRelayOrigin(address);
      return origin ? probeRelay(origin, this.open, this.probeSeed) : { ok: false, reason: 'invalid-address' };
    });
  }

  /** The socket lasts only while a device is paired. */
  private closeIfIdle(): void {
    if (this.devices.list().length > 0 || this.devices.pendingRemovals().length > 0) return;
    this.connection?.stop();
    this.connection = undefined;
    this.setStatus('off');
  }

  // ---- routes ---------------------------------------------------------------------------------

  list(): PhonesResponse {
    const undenied = this.devices.undeniedGrants().length;
    return {
      relayOrigin: this.origin ?? '',
      relaySource: this.address.source,
      relay: { status: this.status, ...(this.detail ? { detail: this.detail } : {}) },
      phones: this.devices.list().map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        platform: device.platform,
        addedAt: device.addedAt,
        ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
        connected: this.sessions.get(device.deviceId)?.proven === true,
        ...(device.push ? { push: true as const } : {}),
      })),
      pairing: this.pairing?.view() ?? null,
      ...(undenied > 0 ? { undeniedGrants: undenied } : {}),
    };
  }

  /** Runs outside any scope, because a pairing outlives the click that started it. */
  startPairing(): Promise<StartPhonePairingResponse> {
    return outsideRelayScope(async () => {
      await this.refreshAddress();
      const origin = this.origin;
      if (!origin) throw new PairingStartError(this.address.source === 'env-invalid' ? 'CEZ_RELAY_URL is not a valid relay address.' : 'Phone pairing is off.');
      if (!this.addressKnown) throw new PairingStartError('Could not read the saved relay address. Fix ~/.cezar/config.json and try again.');
      if (this.changingAddress) throw new PairingStartError('The relay address is changing. Try again in a moment.');
      if (this.pairing && !this.pairing.canReplace) throw new PairingStartError('A phone is waiting for your answer.');
      const now = this.now();
      this.pairingStarts = this.pairingStarts.filter((at) => now - at < HOUR_MS);
      if (this.pairingStarts.length >= PAIRINGS_PER_HOUR) {
        const retryAfter = Math.ceil((this.pairingStarts[0]! + HOUR_MS - now) / 1000);
        throw new PairingStartError('Too many codes this hour. Try again later.', retryAfter);
      }
      this.pairing?.cancel();
      this.pairing?.dispose();
      this.pairing = undefined;
      let identity: RelayIdentity;
      try {
        identity = await this.identityStore.ensure();
      } catch {
        throw new PairingStartError('Could not read the keys for this computer. Unlock the keychain and try again.');
      }
      if (this.changingAddress || this.origin !== origin) throw new PairingStartError('The relay address changed. Try again.');
      this.identity = identity;
      this.pairingStarts.push(now);
      const pairing: Pairing = new Pairing({
        origin,
        identity,
        label: this.label,
        open: this.open,
        onChange: () => { if (this.pairing === pairing) this.onChange(); },
        accepts: (phone) => this.acceptsPhone(phone),
        commit: (phone) => this.commit(phone, identity),
        rollback: (phone) => { this.dropDevice(phone.deviceId); },
      });
      this.pairing = pairing;
      try {
        const credentials = await pairing.start();
        this.onChange();
        return { ...credentials, relayOrigin: origin };
      } catch (error) {
        if (this.pairing === pairing) this.pairing = undefined;
        throw error;
      }
    });
  }

  /** `relayKey` is unproven until the phone's first signed socket, so it cannot take over a row. */
  private acceptsPhone(phone: PairedPhone): boolean {
    const saved = this.devices.get(phone.deviceId);
    return !saved || saved.noiseKey === phone.noiseKey;
  }

  /** Save, open the socket if none, wait for `hello`, `device-add`, wait for its `ack`, § 9.4. */
  private async commit(phone: PairedPhone, identity: RelayIdentity): Promise<void> {
    this.devices.add({
      deviceId: phone.deviceId,
      label: phone.name,
      platform: phone.platform,
      relayKey: phone.relayKey,
      noiseKey: phone.noiseKey,
      addedAt: new Date(this.now()).toISOString(),
      grants: [],
    });
    const connection = this.ensureConnection(identity);
    await connection.whenReady(SOCKET_READY_MS);
    await connection.command({ t: 'device-add', device: phone.deviceId, key: phone.relayKey }, COMMAND_TIMEOUT_MS);
    this.onChange();
  }

  /** Opened only on request, so an expired code nobody asked for costs one rendezvous, § 9.2. */
  pairingCode(id: string): Promise<PhonePairingCodeResponse | null> {
    return outsideRelayScope(async () => {
      const origin = this.origin;
      if (!origin || this.pairing?.id !== id) return null;
      return { code: await this.pairing.revealCode(), relayOrigin: origin };
    });
  }

  approvePairing(id: string): boolean {
    return outsideRelayScope(() => this.pairing?.id === id && this.pairing.approve());
  }

  /** Also how a closed Settings screen cancels: an undecided pairing is discarded. */
  denyPairing(id: string): boolean {
    return outsideRelayScope(() => {
      const pairing = this.pairing;
      if (pairing?.id !== id) return false;
      if (pairing.deny()) return true;
      pairing.cancel();
      return true;
    });
  }

  rename(deviceId: string, label: string): boolean {
    const renamed = this.devices.update(deviceId, { label });
    if (renamed) this.onChange();
    return renamed;
  }

  // ---- the calling phone's push grant (spec R5) --------------------------------------------------

  /** `null` for a device with no row. `managerId` is checked by the caller, which knows the managers. */
  async phonePush(deviceId: string): Promise<PhonePushState | null> {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    const identity = pushBlocked(this.env) ? null : this.identity ?? (await this.identityStore.load().catch(() => null));
    if (!identity) return { available: false };
    const target = this.push.latestManager();
    return {
      available: true,
      cezarKey: b64u(identity.edPublic),
      ...(device.push ? { grantId: device.push.grantId, grantExpiresAt: device.push.expiresAt } : {}),
      ...(target ? { managerId: target } : {}),
    };
  }

  /** `'off'` under `CEZ_PUSH=0`; `null` for a device with no row. */
  async setPhonePush(deviceId: string, input: SetPhonePushGrantInput): Promise<PhonePushState | 'off' | null> {
    if (pushBlocked(this.env)) return 'off';
    if (!this.devices.setPush(deviceId, { grant: input.grant, grantId: input.grantId, expiresAt: input.expiresAt })) return null;
    this.onChange();
    return this.phonePush(deviceId);
  }

  clearPhonePush(deviceId: string): boolean {
    if (!this.devices.get(deviceId)) return false;
    if (this.devices.clearPush(deviceId)) this.onChange();
    return true;
  }

  /** cezar first, complete from that moment: then the session, then the relay, § Removal. */
  remove(deviceId: string): boolean {
    return outsideRelayScope(() => {
      if (!this.devices.get(deviceId)) return false;
      const session = this.sessions.get(deviceId);
      let removal: PendingRemoval | undefined;
      try {
        removal = this.devices.remove(deviceId);
      } finally {
        // A failed write still ends the session: the row is gone from memory either way.
        session?.close(CLOSE.deviceRemoved);
        this.sessions.delete(deviceId);
      }
      if (removal) void this.sendRemoval(removal);
      this.onChange();
      return true;
    });
  }
}

/** A grant list that does not fit `controlBytes` splits across commands for one device, § 4. */
export function removalFrames(removal: PendingRemoval, controlBytes: number): { t: 'device-remove'; device: string; grants?: string[] }[] {
  const base = { t: 'device-remove' as const, device: removal.deviceId };
  if (removal.grants.length === 0) return [base];
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, id: 'x'.repeat(64), grants: [] }));
  const frames: { t: 'device-remove'; device: string; grants: string[] }[] = [];
  let current: string[] = [];
  let size = overhead;
  for (const grant of removal.grants) {
    const cost = Buffer.byteLength(JSON.stringify(grant)) + 1;
    if (current.length > 0 && size + cost > controlBytes) {
      frames.push({ ...base, grants: current });
      current = [];
      size = overhead;
    }
    current.push(grant);
    size += cost;
  }
  frames.push({ ...base, grants: current });
  return frames;
}

export { PairingStartError } from './pairing.ts';
