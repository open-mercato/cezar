import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * `~/.cezar/relay/devices.json`, an own file like `agent-accounts.json` and with its house rules:
 * every field defaulted, unknown keys kept, per-entry salvage, a corrupt file degrades to empty.
 * Deleting it loses pairings, and the user pairs again. State, not configuration.
 */

const b64u22 = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const b64u43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** A grant renews about every 60 days, so this is decades of renewals; it only bounds a phone in a loop. */
export const MAX_GRANT_IDS = 256;

const deviceSchema = z.looseObject({
  deviceId: b64u22,
  label: z.string().max(200).catch('Phone'),
  platform: z.enum(['android', 'ios']),
  relayKey: b64u43,
  noiseKey: b64u43,
  addedAt: z.string().max(64).catch(''),
  lastSeenAt: z.string().max(64).optional().catch(undefined),
  // Every grant id the phone ever handed over, because device-remove lists them (§ 4).
  grants: z.array(z.string().max(64)).catch([]),
  // The one live push grant (spec R5). Sealed by the relay: cezar cannot read the token inside.
  push: z.object({ grant: z.string().min(1).max(4096), grantId: b64u22, expiresAt: z.number().int() }).optional().catch(undefined),
});
export type RelayDevice = z.infer<typeof deviceSchema>;

const removalSchema = z.looseObject({ deviceId: b64u22, grants: z.array(z.string().max(64)).catch([]) });
export type PendingRemoval = z.infer<typeof removalSchema>;

interface DeviceFile {
  devices: RelayDevice[];
  pendingRemovals: PendingRemoval[];
  undeniedGrants: string[];
}

function salvage<T>(schema: z.ZodType<T>, value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export class RelayDevices {
  private state: DeviceFile | undefined;
  private stamp = 0;
  private warned = false;
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'devices.json');
  }

  private fileStamp(): number {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Another `cezar serve` on this home may have written, and a stale write would restore its rows. */
  private read(): DeviceFile {
    const stamp = this.fileStamp();
    if (this.state && stamp === this.stamp) return this.state;
    this.stamp = stamp;
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !this.warned) {
        this.warned = true;
        console.warn('[cezar] ~/.cezar/relay/devices.json is unreadable; treating it as empty');
      }
    }
    this.state = {
      devices: salvage(deviceSchema, raw.devices),
      pendingRemovals: salvage(removalSchema, raw.pendingRemovals),
      undeniedGrants: z.array(z.string()).catch([]).parse(raw.undeniedGrants),
    };
    return this.state;
  }

  private write(): void {
    atomicWriteJsonSync(this.path, { version: 1, ...this.state });
    this.stamp = this.fileStamp();
  }

  list(): readonly RelayDevice[] {
    return this.read().devices;
  }

  get(deviceId: string): RelayDevice | undefined {
    return this.read().devices.find((device) => device.deviceId === deviceId);
  }

  /** A re-paired phone replaces its own row. */
  add(device: RelayDevice): void {
    const state = this.read();
    state.devices = [...state.devices.filter((row) => row.deviceId !== device.deviceId), device];
    state.pendingRemovals = state.pendingRemovals.filter((row) => row.deviceId !== device.deviceId);
    this.write();
  }

  update(deviceId: string, patch: Partial<Pick<RelayDevice, 'label' | 'lastSeenAt'>>): boolean {
    const device = this.get(deviceId);
    if (!device) return false;
    Object.assign(device, patch);
    this.write();
    return true;
  }

  /**
   * The id joins `grants` first and stays there, so Remove still denies a grant later replaced. A full
   * list refuses a new grant rather than evict an id Remove would then no longer deny.
   */
  setPush(deviceId: string, push: NonNullable<RelayDevice['push']>): boolean | 'full' {
    const device = this.get(deviceId);
    if (!device) return false;
    if (!device.grants.includes(push.grantId)) {
      if (device.grants.length >= MAX_GRANT_IDS) return 'full';
      device.grants = [...device.grants, push.grantId];
    }
    device.push = push;
    this.write();
    return true;
  }

  /** `grantId` guards a send that raced a renewal: only the grant that failed is dropped. */
  clearPush(deviceId: string, grantId?: string): boolean {
    const device = this.get(deviceId);
    if (!device?.push || (grantId !== undefined && device.push.grantId !== grantId)) return false;
    delete device.push;
    this.write();
    return true;
  }

  /** Deletes the row and remembers the relay command until its `ack`, § 4 cezar's obligations. */
  remove(deviceId: string): PendingRemoval | undefined {
    const state = this.read();
    const device = state.devices.find((row) => row.deviceId === deviceId);
    if (!device) return undefined;
    const removal = { deviceId, grants: device.grants };
    state.devices = state.devices.filter((row) => row !== device);
    state.pendingRemovals = [...state.pendingRemovals.filter((row) => row.deviceId !== deviceId), removal];
    this.write();
    return removal;
  }

  /**
   * Every row and every queued removal belong to the relay being left, so neither survives a new
   * address: a queued removal would open a socket to, and name a phone to, a relay it never knew.
   * All at once or not at all, and the caller gets them to tell the old relay if it still can.
   */
  forgetAll(): PendingRemoval[] {
    const state = this.read();
    const removals = [...state.pendingRemovals, ...state.devices.map((device) => ({ deviceId: device.deviceId, grants: device.grants }))];
    if (removals.length === 0) return [];
    const { devices, pendingRemovals } = state;
    state.devices = [];
    state.pendingRemovals = [];
    try {
      this.write();
    } catch (error) {
      Object.assign(state, { devices, pendingRemovals });
      throw error;
    }
    return removals;
  }

  pendingRemovals(): readonly PendingRemoval[] {
    return this.read().pendingRemovals;
  }

  settleRemoval(deviceId: string, undenied: readonly string[] = []): void {
    const state = this.read();
    state.pendingRemovals = state.pendingRemovals.filter((row) => row.deviceId !== deviceId);
    state.undeniedGrants = [...state.undeniedGrants, ...undenied];
    this.write();
  }

  undeniedGrants(): readonly string[] {
    return this.read().undeniedGrants;
  }
}
