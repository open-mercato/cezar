import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { setAdapterNotifications } from './adapter-notifications.ts';

it('resumes only its own paused revision and leaves webhook-only and prepaused receivers alone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adapter-notifications-'));
  const rows = [
    { id: 'owned', format: 'slack.v1', state: 'active', revision: 1, chatSecret: { sha256: 'a'.repeat(64) } },
    { id: 'edited', format: 'slack.v1', state: 'active', revision: 1, chatSecret: { sha256: 'b'.repeat(64) } },
    { id: 'prepaused', format: 'slack.v1', state: 'paused', revision: 1, chatSecret: { sha256: 'c'.repeat(64) } },
    { id: 'webhook', format: 'slack.v1', state: 'active', revision: 1 },
  ] as PrivateReceiver[];
  const mutate = async (id: string, revision: number, state: 'active' | 'paused') => {
    const row = rows.find(row => row.id === id)!;
    expect(row.revision).toBe(revision);
    row.revision++; row.state = state; return { revision: row.revision };
  };
  const endpoints = { live: () => structuredClone(rows), assertUsable() {},
    pause: (id: string, revision: number) => mutate(id, revision, 'paused'),
    resume: (id: string, revision: number) => mutate(id, revision, 'active') };
  try {
    await setAdapterNotifications(directory, 'slack', false, endpoints);
    expect(rows.map(row => row.state)).toEqual(['paused', 'paused', 'paused', 'active']);
    rows[1]!.revision++; // An intervening edit owns this receiver now.
    await setAdapterNotifications(directory, 'slack', false, endpoints); // Idempotent disable retains ownership.
    await setAdapterNotifications(directory, 'slack', true, endpoints);
    expect(rows.map(row => row.state)).toEqual(['active', 'paused', 'paused', 'active']);
    await setAdapterNotifications(directory, 'slack', true, endpoints);
    expect(rows[1]!.state).toBe('paused');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
