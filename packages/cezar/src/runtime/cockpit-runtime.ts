import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { healthResponseSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { apiOrigin } from '../api-origin.ts';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import {
  acquireOwnership,
  readOwnershipIdentity,
  type WebhookOwnership,
} from '../webhooks/ownership.ts';
import { assertNoSymlink, atomicWrite, readState, statePath } from '../webhooks/storage.ts';
import {
  isProcessIdentityAlive,
  PROCESS_IDENTITY_UNSUPPORTED_PLATFORM_MESSAGE,
  processIdentityPlatformSupported,
} from './process-identity.ts';

const slotSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const ownerSchema = z.object({
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  start: z.string().regex(/^\d+$/),
  boot: z.string().min(1).max(128),
  host: z.string().min(1).max(255),
  pidNamespace: z.string().regex(/^pid:\[\d+\]$/).optional(),
}).passthrough();

export const cockpitRuntimeRecordSchema = z.object({
  schema: z.literal(1),
  slot: slotSchema,
  runtimeId: z.string().uuid(),
  origin: z.string().url().max(2048),
  port: z.number().int().min(1).max(65535),
  bindHost: z.string().min(1).max(255).optional(),
  version: z.string().min(1).max(128),
  startedAt: z.string().datetime(),
  owner: ownerSchema,
}).passthrough();
export type CockpitRuntimeRecord = z.infer<typeof cockpitRuntimeRecordSchema>;
const MAX_RUNTIME_BYTES = 32 * 1024;

export interface CockpitLease {
  slot: string;
  directory: string;
  ownership: WebhookOwnership;
}

export type CockpitSlotClaim =
  | { kind: 'primary'; lease: CockpitLease }
  | { kind: 'secondary'; slot: string; directory: string }
  | { kind: 'degraded'; slot: string; reason: string }
  | { kind: 'blocked'; slot: string; reason: string };

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function instanceCockpitSlot(instanceId: string): string {
  return `service-${digest(instanceId)}`;
}

export function remoteCockpitSlot(bindHost: string | undefined, port: number): string {
  return `remote-${digest(`${bindHost ?? '127.0.0.1'}\0${port}`)}`;
}

export function resolveCockpitSlot(
  opts: { bindHost?: string; port: number; env?: NodeJS.ProcessEnv },
): string {
  const env = opts.env ?? process.env;
  if (env.CEZ_INSTANCE_ID) return instanceCockpitSlot(env.CEZ_INSTANCE_ID);
  if (env.CEZ_REMOTE === '1') return remoteCockpitSlot(opts.bindHost, opts.port);
  return 'interactive';
}

export function cockpitRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'runtime', 'cockpits');
}

export function cockpitRuntimeDirectory(slot: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cockpitRuntimeRoot(env), slotSchema.parse(slot));
}

async function prepareRuntimeDirectory(slot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const directory = cockpitRuntimeDirectory(slot, env);
  assertCezarHomeWriteIsSandboxed(directory, env);
  assertNoSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

export async function claimCockpitSlot(
  slot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CockpitSlotClaim> {
  if (!processIdentityPlatformSupported()) {
    return { kind: 'degraded', slot, reason: PROCESS_IDENTITY_UNSUPPORTED_PLATFORM_MESSAGE };
  }
  let directory: string;
  try {
    directory = await prepareRuntimeDirectory(slot, env);
  } catch (error) {
    return { kind: 'degraded', slot, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const ownership = await acquireOwnership(directory);
    return ownership
      ? { kind: 'primary', lease: { slot, directory, ownership } }
      : { kind: 'secondary', slot, directory };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Keep the old startup available when identity probing failed before anybody established
    // ownership. An authoritative owner or in-flight candidate is ambiguous and remains protected.
    try {
      const owner = readOwnershipIdentity(directory);
      const candidates = (await readdir(directory)).some((name) => /^owner-(?:record|next|publication)-/.test(name));
      return owner || candidates
        ? { kind: 'blocked', slot, reason }
        : { kind: 'degraded', slot, reason };
    } catch {
      return { kind: 'blocked', slot, reason };
    }
  }
}

export async function readCockpitRuntime(
  slot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CockpitRuntimeRecord | undefined> {
  return readState(cockpitRuntimeDirectory(slot, env), 'runtime.json', cockpitRuntimeRecordSchema, MAX_RUNTIME_BYTES);
}

export async function publishCockpitRuntime(
  lease: CockpitLease,
  input: {
    runtimeId: string;
    port: number;
    bindHost?: string;
    version: string;
    startedAt?: string;
  },
): Promise<CockpitRuntimeRecord> {
  if (!lease.ownership.valid()) throw new Error('cockpit runtime lease was lost before publication');
  const identity = lease.ownership.identity;
  const owner = {
    token: identity.token,
    pid: identity.pid,
    start: identity.start,
    boot: identity.boot,
    host: identity.host,
    ...(identity.pidNamespace === undefined ? {} : { pidNamespace: identity.pidNamespace }),
  };
  const record = cockpitRuntimeRecordSchema.parse({
    schema: 1,
    slot: lease.slot,
    runtimeId: input.runtimeId,
    origin: apiOrigin(input.bindHost, input.port),
    port: input.port,
    ...(input.bindHost === undefined ? {} : { bindHost: input.bindHost }),
    version: input.version,
    startedAt: input.startedAt ?? new Date().toISOString(),
    owner,
  });
  await atomicWrite(lease.directory, 'runtime.json', record);
  return record;
}

export async function releaseCockpitRuntime(lease: CockpitLease): Promise<void> {
  try {
    const record = await readState(lease.directory, 'runtime.json', cockpitRuntimeRecordSchema, MAX_RUNTIME_BYTES);
    if (record?.owner.token === lease.ownership.identity.token) {
      await rm(statePath(lease.directory, 'runtime.json'), { force: true });
    }
  } finally {
    await lease.ownership.release();
  }
}

export type RuntimeInspection =
  | { kind: 'verified'; runtime: CockpitRuntimeRecord }
  | { kind: 'absent' }
  | { kind: 'dead'; runtime?: CockpitRuntimeRecord }
  | { kind: 'unavailable'; runtime?: CockpitRuntimeRecord; reason: string };

export async function inspectCockpitRuntime(
  slot: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<RuntimeInspection> {
  const env = opts.env ?? process.env;
  const directory = cockpitRuntimeDirectory(slot, env);
  let runtime: CockpitRuntimeRecord | undefined;
  let runtimeError: string | undefined;
  try {
    runtime = await readCockpitRuntime(slot, env);
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  }
  let publishedOwner: ReturnType<typeof readOwnershipIdentity>;
  try {
    publishedOwner = readOwnershipIdentity(directory);
  } catch (error) {
    return { kind: 'unavailable', runtime, reason: error instanceof Error ? error.message : String(error) };
  }
  // `owner.lock` is authoritative. A runtime projection without it is stale disposable state;
  // a live owner without a ready projection remains protected below.
  if (!publishedOwner) return { kind: 'absent' };
  try {
    if (!(await isProcessIdentityAlive(publishedOwner))) {
      return runtime === undefined ? { kind: 'dead' } : { kind: 'dead', runtime };
    }
  } catch (error) {
    return { kind: 'unavailable', runtime, reason: error instanceof Error ? error.message : String(error) };
  }
  if (runtimeError) return { kind: 'unavailable', reason: runtimeError };
  if (!runtime) return { kind: 'unavailable', reason: 'the live owner has not published runtime state yet' };
  if (publishedOwner.token !== runtime.owner.token
    || publishedOwner.pid !== runtime.owner.pid
    || publishedOwner.start !== runtime.owner.start
    || publishedOwner.boot !== runtime.owner.boot
    || publishedOwner.host !== runtime.owner.host
    || publishedOwner.pidNamespace !== runtime.owner.pidNamespace) {
    return { kind: 'unavailable', runtime, reason: 'runtime record does not match the published owner lease' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1_000);
  try {
    const response = await (opts.fetcher ?? fetch)(`${runtime.origin}/api/v1/health`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { kind: 'unavailable', runtime, reason: `health answered ${response.status}` };
    const health = healthResponseSchema.safeParse(await response.json());
    if (!health.success) return { kind: 'unavailable', runtime, reason: 'health contract is incompatible' };
    if (health.data.runtimeId !== runtime.runtimeId) {
      return { kind: 'unavailable', runtime, reason: 'health runtime identity does not match the lease' };
    }
    return { kind: 'verified', runtime };
  } catch (error) {
    return { kind: 'unavailable', runtime, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForCockpitRuntime(
  slot: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<RuntimeInspection> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  let last: RuntimeInspection = { kind: 'absent' };
  while (Date.now() < deadline) {
    last = await inspectCockpitRuntime(slot, {
      env: opts.env,
      fetcher: opts.fetcher,
      timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
    });
    if (last.kind === 'verified' || last.kind === 'dead') return last;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 100));
  }
  return last;
}

export function newRuntimeId(): string {
  return randomUUID();
}

