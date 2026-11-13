import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { BotLease, botDirectory } from './ownership.ts';
import { chatProviderIdSchema } from '@open-mercato/cezar-contract';
import { ChatBindings } from './bindings.ts';
it('lists a live owner without acquiring its lease, then releases only an orphan with matching revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-binding-')), botId = String(randomInt(100000, 99999999));
  const lease = await BotLease.acquire(botId), binding = await lease.bind({ projectId: 'project', root, installationId: 'installation' });
  let projects = [{ id: 'project', root, status: 'ready' }];
  const service = new ChatBindings({ mode: () => 'local', projects: async () => projects });
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  try {
    const before = await readdir(botDirectory(botId));
    const row = (await service.list()).bindings.find(item => item.botId === botId)!;
    expect(row).toMatchObject({ orphaned: false, projectId: 'project' });
    expect(JSON.stringify(row)).not.toContain(root); expect(await readdir(botDirectory(botId))).toEqual(before);
    projects = [];
    await expect(service.release(botId, row.inboundRevision)).rejects.toThrow('owner_conflict');
    await lease.release();
    await expect(service.release(botId, 'a'.repeat(64))).rejects.toMatchObject({ code: 'revision_conflict' });
    await service.release(botId, row.inboundRevision);
    const next = await BotLease.acquire(botId);
    try { expect(await next.binding()).toBeUndefined(); await expect(next.validate(binding)).rejects.toThrow('binding_missing'); }
    finally { await next.release(); }
  } finally { await lease.release(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
it('rechecks project presence and gates mutation before touching ownership files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-binding-')), botId = String(randomInt(100000, 99999999));
  const lease = await BotLease.acquire(botId); await lease.bind({ projectId: 'project', root, installationId: 'installation' }); await lease.release();
  let projects: { id: string; root: string; status: string }[] = [];
  const service = new ChatBindings({ mode: () => 'local', projects: async () => projects, visibleProject: () => 'project' });
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  try {
    const row = (await service.list()).bindings.find(item => item.botId === botId)!;
    projects = [{ id: 'project', root, status: 'ready' }];
    await expect(service.release(botId, row.inboundRevision)).rejects.toMatchObject({ code: 'project_present' });
    // Notifications alone can bind a bot, so diagnostics and release need only webhooks.
    vi.stubEnv('CEZ_CHAT_INBOUND', '0'); projects = [];
    const listed = (await service.list()).bindings.find(item => item.botId === botId)!;
    expect(listed).toMatchObject({ orphaned: true, projectId: 'project' });
    vi.stubEnv('CEZ_WEBHOOKS', '0');
    await expect(service.release(botId, listed.inboundRevision)).rejects.toMatchObject({ code: 'webhooks_off' });
    vi.stubEnv('CEZ_WEBHOOKS', '1');
    await expect(service.release(botId, listed.inboundRevision)).resolves.toEqual({ released: true });
  } finally { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
it('diagnostics do not create a missing home or follow a symlinked binding file', async () => {
  const { symlink, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const outer = await mkdtemp(join(tmpdir(), 'telegram-binding-read-'));
  vi.stubEnv('CEZ_HOME', join(outer, 'absent-home')); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const service = new ChatBindings({ mode: () => 'local', projects: async () => [] });
  try {
    expect(await service.list()).toEqual({ bindings: [], truncated: false });
    expect(existsSync(join(outer, 'absent-home'))).toBe(false);
    const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
    await lease.release();
    const target = join(outer, 'private.json'); await writeFile(target, JSON.stringify({ secret: 'must not read' }));
    await symlink(target, join(botDirectory(botId), 'binding.json'));
    expect(await service.list()).toEqual({ bindings: [], truncated: true });
  } finally { vi.unstubAllEnvs(); await rm(outer, { recursive: true, force: true }); }
});
it('lists no bindings while hosted or webhooks are off, even when one exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-binding-')), botId = String(randomInt(100000, 99999999));
  const lease = await BotLease.acquire(botId); await lease.bind({ projectId: 'project', root, installationId: 'installation' }); await lease.release();
  let mode: 'local' | 'hosted' = 'local';
  const service = new ChatBindings({ mode: () => mode, projects: async () => [] });
  try {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
    expect((await service.list()).bindings.some(row => row.botId === botId)).toBe(true);
    mode = 'hosted'; expect(await service.list()).toEqual({ bindings: [], truncated: false });
    mode = 'local'; vi.stubEnv('CEZ_WEBHOOKS', '0'); expect(await service.list()).toEqual({ bindings: [], truncated: false });
    expect((await service.scan()).bindings.some(row => row.botId === botId)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});

it.skipIf(process.platform === 'win32')('skips a FIFO binding without stalling discovery of healthy bots', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const outer = await mkdtemp(join(tmpdir(), 'telegram-binding-fifo-'));
  vi.stubEnv('CEZ_HOME', outer);
  try {
    await mkdir(botDirectory('123'), { recursive: true });
    execFileSync('mkfifo', [join(botDirectory('123'), 'binding.json')], { timeout: 1000 });
    const lease = await BotLease.acquire('456');
    try { await lease.bind({ projectId: 'healthy', root: outer, installationId: 'installation' }); }
    finally { await lease.release(); }
    const source = new URL('./bindings.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { chatProviderIdSchema } from '@open-mercato/cezar-contract';
import { ChatBindings } from ${JSON.stringify(source)}; const result = await new ChatBindings({ mode: () => 'local', projects: async () => [] }).scan(); console.log(JSON.stringify(result));`],
      { timeout: 3000, encoding: 'utf8' });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ truncated: true, bindings: [{ botId: '456', projectId: 'healthy' }] });
  } finally { vi.unstubAllEnvs(); await rm(outer, { recursive: true, force: true }); }
});
it('scopes inactive binding diagnostics and release to the provider even for matching revisions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-binding-providers-'));
  vi.stubEnv('CEZ_HOME', home); vi.stubEnv('CEZ_WEBHOOKS', '1');
  try {
    const telegram = await BotLease.acquire('123', false, 'telegram');
    const binding = await telegram.bind({ projectId: 'project', root: home, installationId: 'instance' }); await telegram.release();
    const scan = (provider: string) => new ChatBindings({ provider, mode: () => 'local', projects: async () => [] });
    const row = (await scan('telegram').scan()).bindings[0]!;
    expect((await scan('acme/chat').scan()).bindings).toEqual([]);
    await expect(scan('acme/chat').release('123', row.inboundRevision)).rejects.toMatchObject({ code: 'binding_missing' });
    const rightful = await BotLease.acquire('123', false, 'telegram');
    try { expect(await rightful.binding()).toEqual(binding); }
    finally { await rightful.release(); }
    await scan('telegram').release('123', row.inboundRevision);
  } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});

const nativeProviders = ['telegram'];
const providerModes = nativeProviders.flatMap(provider => [false, true].flatMap(nativeDryRun =>
  [false, true].flatMap(qualifiedDryRun => [false, true].map(reverse => ({ provider, nativeDryRun, qualifiedDryRun, reverse })))));
it.each(providerModes)('isolates qualified/native scans and release: %j', async ({ provider, nativeDryRun, qualifiedDryRun, reverse }) => {
  const home = await mkdtemp(join(tmpdir(), 'chat-qualified-binding-'));
  vi.stubEnv('CEZ_HOME', home); vi.stubEnv('CEZ_WEBHOOKS', '1');
  const native = { provider, dryRun: nativeDryRun };
  const qualified = { provider: `${provider}/dry-run`, dryRun: qualifiedDryRun };
  const source = reverse ? qualified : native, target = reverse ? native : qualified;
  const scanner = (scope: { provider: string; dryRun: boolean }) => new ChatBindings({ ...scope, mode: () => 'local', projects: async () => [] });
  try {
    const lease = await BotLease.acquire('123', source.dryRun, source.provider);
    let binding;
    try { binding = await lease.bind({ projectId: 'project', root: home, installationId: 'instance' }); }
    finally { await lease.release(); }
    const row = (await scanner(source).scan()).bindings[0]!;
    expect(row).toBeDefined();
    // Include the other native platforms as negative controls, in both modes.
    const targets = [target, ...nativeProviders.filter(p => p !== provider).flatMap(p => [false, true].map(dryRun => ({ provider: p, dryRun })))];
    for (const scope of targets) {
      expect.soft((await scanner(scope).scan()).bindings).toEqual([]);
      await expect(scanner(scope).release('123', row.inboundRevision)).rejects.toMatchObject({ code: 'binding_missing' });
    }
    const rightful = await BotLease.acquire('123', source.dryRun, source.provider);
    try { expect(await rightful.binding()).toEqual(binding); }
    finally { await rightful.release(); }
    await expect(scanner(source).release('123', row.inboundRevision)).resolves.toEqual({ released: true });
  } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});
it('accepts qualified IDs as single path segments without changing native paths', () => {
  for (const provider of nativeProviders) {
    for (const dryRun of [false, true]) {
      expect(botDirectory('123', dryRun, provider)).toMatch(new RegExp(`/chat/${provider}/${dryRun ? 'dry-run/' : ''}bots/123$`));
    }
  }
  for (const provider of ['telegram/dry-run', 'local/chat', 'my.extension-1/chat_v2']) {
    expect(chatProviderIdSchema.safeParse(provider).success).toBe(true);
    expect(botDirectory('123', false, provider)).toContain(`/chat/${encodeURIComponent(provider)}/bots/123`);
    const encoded = encodeURIComponent(provider);
    expect(chatProviderIdSchema.safeParse(encoded).success).toBe(false);
    expect(() => botDirectory('123', false, encoded)).toThrow('Invalid chat provider');
  }
});
