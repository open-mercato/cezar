import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { applyProviderChanges, providerCatalog, providerEntries } from './service.ts';
import { cachedPiSubscriptions, piSubscriptionStatus } from './pi-subscriptions.ts';

afterEach(() => vi.unstubAllEnvs());

it('shares concurrent lookups for the same Pi home', async () => {
  const probe = vi.fn(async (id: string) => id === 'anthropic' ? 'connected' as const : 'unknown' as const);
  const read = cachedPiSubscriptions(probe);
  await Promise.all([read('/test'), read('/test')]);
  expect(await read('/test')).toEqual({ anthropic: 'connected', 'openai-codex': 'unknown' });
  expect(probe).toHaveBeenCalledTimes(2);
  vi.stubEnv('PI_CODING_AGENT_DIR', '/second-test-home');
  await read('/test');
  expect(probe).toHaveBeenCalledTimes(4);
});

it.skipIf(process.platform === 'win32')('requires the exact provider and OAuth type from the offline status command', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-method-fixture-'));
  try {
    const file = join(cwd, 'pi');
    await writeFile(file, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'auth check --provider anthropic --json --no-refresh') process.exit(2);
console.log(JSON.stringify({ provider: 'anthropic', status: 'ready', authType: process.env.TEST_AUTH_TYPE }));
`);
    await chmod(file, 0o700);
    vi.stubEnv('CEZ_PI_BIN', file);
    expect(await piSubscriptionStatus('anthropic', cwd, { PATH: process.env.PATH, TEST_AUTH_TYPE: 'oauth' })).toBe('connected');
    expect(await piSubscriptionStatus('anthropic', cwd, { PATH: process.env.PATH, TEST_AUTH_TYPE: 'api_key' })).toBe('disconnected');
    expect(await piSubscriptionStatus('openai-codex', cwd, { PATH: process.env.PATH })).toBe('unknown');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('shows a verified native login beside a saved Pi endpoint only after configuration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-settings-fixture-'));
  try {
    const exe = join(cwd, 'pi');
    const calls = join(cwd, 'calls');
    await writeFile(exe, `#!/usr/bin/env node
const provider = process.argv[5];
require('node:fs').appendFileSync(${JSON.stringify(calls)}, provider + '\\n');
const ready = provider === 'anthropic';
console.log(JSON.stringify({provider, status: ready ? 'ready' : 'not_ready', ...(ready && {authType:'oauth'})}));
process.exitCode = ready ? 0 : 1;
`);
    await chmod(exe, 0o700);
    vi.stubEnv('CEZ_PI_BIN', exe);
    vi.stubEnv('CEZ_HOME', cwd);
    vi.stubEnv('CEZ_SECRETS_KEYCHAIN', '0');
    vi.stubEnv('CEZ_DRY_RUN', '0');
    const row = { provider: 'pi' as const, status: 'connected' as const };
    await providerEntries([row]);
    await expect(readFile(calls)).rejects.toMatchObject({ code: 'ENOENT' });
    await applyProviderChanges([{ runner: 'pi', methods: [{ id: 'openrouter', apiKey: 'fixture-key' }] }], 'cli', [row]);
    const entry = (await providerEntries([row])).find(agent => agent.runner === 'pi');
    expect(entry?.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'anthropic', state: 'connected' }),
      expect.objectContaining({ id: 'openai-codex', state: 'disconnected' }),
    ]));
    const catalog = await providerCatalog('pi', async () => ({
      runner: 'pi', source: 'live', stale: false,
      models: [{ id: 'anthropic/one', label: 'One', description: '' }],
    }), () => row);
    expect(catalog.models[0]?.via?.methodId).toBe('anthropic');
    expect((await readFile(calls, 'utf8')).trim().split('\n').sort()).toEqual(['anthropic', 'openai-codex']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
