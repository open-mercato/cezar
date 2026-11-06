import { describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { BotLease, botDirectory } from './ownership.ts';

const identity = { projectId: 'project', installationId: 'instance', root: '/repo' };
const botId = () => String(randomInt(1_000_000, 999_999_999));
describe('Telegram bot ownership', () => {
  it('keeps a binding after release and refuses a second project', async () => {
    const id = botId(), first = await BotLease.acquire(id);
    const binding = await first.bind(identity);
    await first.release();
    const second = await BotLease.acquire(id);
    try {
      expect(await second.bind(identity)).toEqual(binding);
      await expect(second.bind({ ...identity, projectId: 'other' })).rejects.toThrow('binding_conflict');
    } finally { await second.release(); }
  });
  it('prevents a second consumer while the first owns even an unbound bot', async () => {
    const id = botId(), lease = await BotLease.acquire(id);
    try { await expect(BotLease.acquire(id)).rejects.toThrow('owner_conflict'); }
    finally { await lease.release(); }
    const next = await BotLease.acquire(id); await next.release();
  });
  it('reassignment invalidates the old generation and dry-run does not occupy a real bot', async () => {
    const id = botId(), lease = await BotLease.acquire(id);
    const binding = await lease.bind(identity);
    const dry = await BotLease.acquire(id, true);
    await dry.release();
    expect(botDirectory(id, true)).not.toBe(botDirectory(id));
    await lease.disconnect(binding);
    const replacement = await lease.bind(identity);
    expect(replacement.generation).not.toBe(binding.generation);
    await expect(lease.validate(binding)).rejects.toThrow('binding_changed');
    await lease.release();
  });
});
it('reuses a verified owner check on hot read paths but never for writes', async () => {
  const id = botId(), lease = await BotLease.acquire(id);
  try {
    const valid = vi.spyOn((lease as unknown as { owner: { valid(): boolean } }).owner, 'valid');
    lease.assertOwner(); lease.assertOwnerCached(); lease.assertOwnerCached();
    expect(valid).toHaveBeenCalledTimes(1);
    lease.assertOwner(); expect(valid).toHaveBeenCalledTimes(2);
    valid.mockReturnValue(false);
    expect(() => lease.assertOwner()).toThrow('owner_conflict');
    expect(() => lease.assertOwnerCached()).toThrow('owner_conflict');
  } finally { vi.restoreAllMocks(); await lease.release(); }
});
