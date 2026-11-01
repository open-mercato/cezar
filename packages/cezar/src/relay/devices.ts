import { readFileSync } from 'node:fs';
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

const deviceSchema = z.looseObject({
  deviceId: b64u22,
  label: z.string().max(200).catch('Phone'),
  platform: z.enum(['android', 'ios']),
  relayKey: b64u43,
  noiseKey: b64u43,
  addedAt: z.string().max(64).catch(''),
  lastSeenAt: z.string().max(64).optional().catch(undefined),
  // Sealed grants arrive with push (R5); the ids are tracked now because device-remove lists them.
  grants: z.array(z.string().max(64)).catch([]),
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
  private warned = false;
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'devices.json');
  }

  private read(): DeviceFile {
    if (this.state) return this.state;
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
    atomicWriteJsonSync(this.path, { version: 1, ...this.read() });
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

  /** Deletes the row and remembers the relay command until its `ack`, § 4 cezar's obligations. */
  remove(deviceId: string): PendingRemoval | undefined {
    const state = this.read();
    const device = this.get(deviceId);
    if (!device) return undefined;
    const removal = { deviceId, grants: device.grants };
    state.devices = state.devices.filter((row) => row !== device);
    state.pendingRemovals = [...state.pendingRemovals.filter((row) => row.deviceId !== deviceId), removal];
    this.write();
    return removal;
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
