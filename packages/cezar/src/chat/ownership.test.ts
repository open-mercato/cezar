import { describe, expect, it, vi } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
describe('bot directory', () => {
  // S1: the provider is the one path segment a route parameter can reach.
  it.each(['../evil', '../../evil/x', 'acme/../../x', '/abs', 'acme/chat/extra', 'Acme/chat', '', '..', 'acme\\chat'])('rejects provider %j', provider => {
    expect(() => botDirectory('123', false, provider)).toThrow('Invalid chat provider');
  });
  it.each(['telegram', 'acme/chat', 'acme.tools/chat-x'])('keeps provider-scoped paths for %j', provider => {
    expect(botDirectory('123', false, provider)).toMatch(new RegExp(`chat/${encodeURIComponent(provider)}/bots/123$`));
  });
});
it('allows unrelated providers with the same bot ID', async () => {
  const id = botId(), lease = await BotLease.acquire(id, false, 'telegram');
  try { const other = await BotLease.acquire(id, false, 'acme/chat'); await other.release(); }
  finally { await lease.release(); }
});
it('retains the existing provider-scoped binding and lock location', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-ownership-path-'));
  const id = botId();
  vi.stubEnv('CEZ_HOME', home);
  const existing = join(home, 'chat', 'telegram', 'bots', id);
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'binding.json'), JSON.stringify({ ...identity, generation: randomUUID() }));
  const lease = await BotLease.acquire(id, false, 'telegram');
  try {
    await expect(lease.binding()).resolves.toMatchObject(identity);
    expect(lease.directory).toBe(existing);
    await expect(access(existing)).resolves.toBeUndefined();
    await expect(access(botDirectory(id))).resolves.toBeUndefined();
  } finally {
    await lease.release();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
it('keeps the provider lease exclusive across processes', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = await mkdtemp(join(tmpdir(), 'chat-owner-process-'));
  vi.stubEnv('CEZ_HOME', home);
  const lease = await BotLease.acquire('123', false, 'telegram');
  try {
    const source = new URL('./ownership.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { BotLease } from ${JSON.stringify(source)};
       try { const lease = await BotLease.acquire('123', false, 'telegram'); await lease.release(); process.exitCode = 1; }
       catch (error) { if (error.code !== 'owner_conflict') throw error; }
       const other = await BotLease.acquire('123', false, 'acme/chat'); await other.release();`],
    { encoding: 'utf8', timeout: 5000 });
    expect(child.error).toBeUndefined(); expect(child.stderr).toBe(''); expect(child.status).toBe(0);
    expect(() => lease.assertOwner()).not.toThrow();
  } finally { await lease.release(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});
