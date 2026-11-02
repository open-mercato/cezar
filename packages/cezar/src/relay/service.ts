import { hostname } from 'node:os';
import { join } from 'node:path';
import type { PhonePairingCodeResponse, PhonesResponse, RelayStatus, StartPhonePairingResponse } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { RelayCommandError, RelayConnection, COMMAND_TIMEOUT_MS } from './connection.ts';
import { RelayDevices, type PendingRemoval } from './devices.ts';
import { RelayIdentityStore, RelayKeysLocked, type RelayIdentity } from './identity.ts';
import { Pairing, PairingStartError } from './pairing.ts';
import type { PairedPhone } from './rendezvous.ts';
import { outsideRelayScope, runInRelayScope } from './scope.ts';
import { PhoneSession } from './session.ts';
import { openWebSocket, type SocketFactory } from './socket.ts';
import { CLOSE, fromB64u, relayOrigin } from './wire.ts';

export const PAIRINGS_PER_HOUR = 5;
const HOUR_MS = 3_600_000;
const SOCKET_READY_MS = 8_000;

export interface RelayServiceOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  open?: SocketFactory;
  identity?: RelayIdentityStore;
  label?: string;
  now?: () => number;
}

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

  constructor(options: RelayServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.open = options.open ?? openWebSocket;
    this.directory = options.directory ?? join(cezarHomeDir(this.env), 'relay');
    this.identityStore = options.identity ?? new RelayIdentityStore(this.directory);
    this.devices = new RelayDevices(this.directory);
    this.label = options.label ?? (truncateBytes(hostname(), 64) || 'Computer');
    this.now = options.now ?? Date.now;
  }

  /** Wired once the app exists: dispatched requests enter through `fetcher`. */
  attach(fetcher: (request: Request) => Promise<Response>, onChange: () => void): void {
    this.fetcher = fetcher;
    this.onChange = onChange;
  }

  private get origin(): string | null {
    return relayOrigin(this.env);
  }

  /** Reconnects at boot only if there is something to do. Never fails boot. */
  async start(): Promise<void> {
    if (!this.origin || this.disposed) return;
    try {
      if (this.devices.list().length === 0 && this.devices.pendingRemovals().length === 0) return;
      const identity = await this.identityStore.load();
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
      relay: { status: this.status, ...(this.detail ? { detail: this.detail } : {}) },
      phones: this.devices.list().map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        platform: device.platform,
        addedAt: device.addedAt,
        ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
        connected: this.sessions.get(device.deviceId)?.proven === true,
      })),
      pairing: this.pairing?.view() ?? null,
      ...(undenied > 0 ? { undeniedGrants: undenied } : {}),
    };
  }

  /** Runs outside any scope, because a pairing outlives the click that started it. */
  startPairing(): Promise<StartPhonePairingResponse> {
    return outsideRelayScope(async () => {
      const origin = this.origin;
      if (!origin) throw new PairingStartError('Phone pairing is off.');
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
