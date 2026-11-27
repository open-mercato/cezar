import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyProvidersDocument, runProvidersCommand } from './agent-providers-cli.ts';
import { readAgentProviders, readAgentProviderKey } from './workspace/agent-providers.ts';

let home: string;
const logins = async () => [{ provider: 'claude' as const, status: 'connected' as const, methods: { subscription: 'connected' as const } }];
const key = 'example-provider-fixture-1234';
const io = { stdin: async () => key, log: vi.fn(), error: vi.fn(), logins };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cez-providers-cli-'));
  vi.stubEnv('CEZ_HOME', home);
  vi.stubEnv('CEZ_SECRETS_KEYCHAIN', '0');
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_TEST_PROVIDER', key);
  vi.clearAllMocks();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

it('applies inputs atomically, preserving unnamed methods and never printing the key', async () => {
  const doc = { version: 1, agents: { claude: { methods: { openrouter: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } }, active: 'openrouter' } } };
  expect(await runProvidersCommand(['set', 'codex', 'custom', '--base-url', 'https://example.test', '--key-stdin', '--active'], io)).toBe(0);
  expect(await runProvidersCommand(['apply', JSON.stringify(doc)], io)).toBe(0);
  const first = await readAgentProviders();
  expect(first.agents.claude).toMatchObject({ active: 'openrouter', methods: { openrouter: { keyHint: '…1234', origin: 'file' } } });
  expect(await readAgentProviderKey('codex', 'custom')).toBe(key);
  expect(await runProvidersCommand(['apply', JSON.stringify(doc), '--no-fetch'], io)).toBe(0);
  expect(await readAgentProviders()).toEqual(first);
  const bad = { ...doc, agents: { ...doc.agents, cursor: { methods: { custom: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } } } };
  expect(await runProvidersCommand(['apply', JSON.stringify(bad)], io)).toBe(1);
  expect(await readAgentProviders()).toEqual(first);
  expect(await runProvidersCommand(['list', '--json'], io)).toBe(0);
  expect(JSON.stringify([io.log.mock.calls, io.error.mock.calls])).not.toContain(key);
  expect(await readFile(join(home, 'agent-providers.json'), 'utf8')).not.toContain(key);
});

it('enforces file permissions on the opened file and rejects literals in argv', async () => {
  const document = JSON.stringify({ version: 1, agents: { claude: { methods: { openrouter: { apiKey: key } } } } });
  const path = join(home, 'providers.json');
  await writeFile(path, document, { mode: 0o644 });
  await chmod(path, 0o644);
  expect(await runProvidersCommand(['apply', path], io)).toBe(1);
  expect(io.error).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  expect(await runProvidersCommand(['apply', document], io)).toBe(1);
  expect(await runProvidersCommand(['set', 'claude', 'openrouter', '--api-key', key], io)).toBe(1);
  expect((await readAgentProviders()).agents).toEqual({});
  await chmod(path, 0o600);
  expect(await runProvidersCommand(['apply', path], io)).toBe(0);
  await applyProvidersDocument('-', async () => document, logins);
  expect(await readAgentProviderKey('claude', 'openrouter')).toBe(key);
  expect(JSON.stringify(io.error.mock.calls)).not.toContain(key);
});

it('refuses missing and ambiguous sources, and explicitly clears the active method on removal', async () => {
  expect(await runProvidersCommand(['set', 'claude', 'openrouter', '--key-env', 'MISSING_TEST_KEY'], io)).toBe(1);
  expect(await runProvidersCommand(['set', 'claude', 'openrouter', '--key-env', 'CEZ_TEST_PROVIDER', '--key-stdin'], io)).toBe(1);
  expect(await runProvidersCommand(['set', 'claude', 'openrouter', '--key-stdin', '--active'], io)).toBe(0);
  expect(await runProvidersCommand(['select', 'claude', 'subscription'], io)).toBe(0);
  expect(await runProvidersCommand(['select', 'claude', 'openrouter'], io)).toBe(0);
  expect(await runProvidersCommand(['remove', 'claude', 'openrouter'], io)).toBe(0);
  expect((await readAgentProviders()).agents.claude).toMatchObject({ active: null, methods: {} });
  expect(await readAgentProviderKey('claude', 'openrouter')).toBeUndefined();
});

it('resolves a key file once and leaves an empty agent entry unconfigured', async () => {
  const file = join(home, 'gateway-key');
  await writeFile(file, key + '\n', { mode: 0o600 });
  const doc = { version: 1, agents: { codex: { methods: { custom: { baseUrl: 'https://gateway.test', apiKeyFile: file } } }, claude: {} } };
  expect(await runProvidersCommand(['apply', JSON.stringify(doc)], io)).toBe(0);
  await rm(file);
  expect(await readAgentProviderKey('codex', 'custom')).toBe(key);
  expect((await readAgentProviders()).agents.claude).toBeUndefined();
});
