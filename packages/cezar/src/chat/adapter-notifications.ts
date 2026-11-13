import { mkdir, unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { atomicWrite, readState, statePath, syncDirectory } from '../webhooks/storage.ts';

const pausedSchema = z.array(z.strictObject({ id: z.string().min(1).max(128), revision: z.number().int().nonnegative() })).max(1000);
/** Persist the existing pause state, which older hosts also honor. */
export async function setAdapterNotifications(directory: string, provider: string, enabled: boolean, endpoints: {
  live(): PrivateReceiver[];
  pause(id: string, revision: number): Promise<{ revision: number }>;
  resume(id: string, revision: number): Promise<unknown>;
  assertUsable(): void;
}): Promise<void> {
  endpoints.assertUsable();
  const path = statePath(directory, 'adapter-notifications'), name = `${Buffer.from(provider).toString('base64url')}.json`;
  let owned = await readState(path, name, pausedSchema, 128 * 1024) ?? [];
  if (!enabled) {
    const receivers = endpoints.live().filter(row => row.format === `${provider}.v1` && row.chatSecret && ['active', 'suspended'].includes(row.state));
    if (!receivers.length) return;
    await mkdir(path, { recursive: true, mode: 0o700 });
    // Check storage before effects. A crash after pause but before recording its
    // revision leaves notifications safely paused, requiring explicit Resume.
    await atomicWrite(path, name, owned);
    for (const row of receivers) {
      endpoints.assertUsable();
      const paused = await endpoints.pause(row.id, row.revision);
      owned = [...owned.filter(item => item.id !== row.id), { id: row.id, revision: paused.revision }];
      await atomicWrite(path, name, owned);
    }
    return;
  }
  if (!owned.length) return;
  for (const row of owned) {
    endpoints.assertUsable();
    const current = endpoints.live().find(item => item.id === row.id);
    if (current?.format === `${provider}.v1` && current.chatSecret && current.state === 'paused' && current.revision === row.revision) {
      await endpoints.resume(row.id, row.revision);
    }
  }
  endpoints.assertUsable();
  await unlink(statePath(path, name)); await syncDirectory(path);
}
