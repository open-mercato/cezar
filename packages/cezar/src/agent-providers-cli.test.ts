import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyProvidersAtStartup, runProvidersCommand } from './agent-providers-cli.ts';
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
  expect(await runProvidersCommand(['apply', '-'], { ...io, stdin: async () => document })).toBe(0);
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

it('saves an explicitly selected key or additive method without starting a login probe', async () => {
  const noProbe = { ...io, logins: vi.fn(async () => { throw new Error('unexpected login probe'); }) };
  expect(await runProvidersCommand(['set', 'gemini', 'apiKey', '--key-env', 'CEZ_TEST_PROVIDER', '--active', '--no-fetch'], noProbe)).toBe(0);
  expect(await runProvidersCommand(['set', 'gemini', 'apiKey', '--key-env', 'CEZ_TEST_PROVIDER', '--no-fetch'], noProbe)).toBe(0);
  const additive = { version: 1, agents: { pi: { methods: { openrouter: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } } } };
  expect(await runProvidersCommand(['apply', JSON.stringify(additive), '--no-fetch'], noProbe)).toBe(0);
  expect(noProbe.logins).not.toHaveBeenCalled();
  expect(await readAgentProviderKey('pi', 'openrouter')).toBe(key);
  expect(process.env.CEZ_TEST_PROVIDER).toBe(key);
});

it('keeps an existing subscription as the default when importing another method and discovers logins for list', async () => {
  const discovery = vi.fn(logins);
  const cli = { ...io, logins: discovery };
  expect(await runProvidersCommand(['set', 'claude', 'openrouter', '--key-env', 'CEZ_TEST_PROVIDER', '--no-fetch'], cli)).toBe(0);
  expect((await readAgentProviders()).agents.claude?.active).toBe('subscription');
  discovery.mockClear();
  expect(await runProvidersCommand(['list', '--json'], cli)).toBe(0);
  expect(discovery).toHaveBeenCalledOnce();
});

it('probes only the requested subscription in a mixed import and hides every source for the duration of that probe', async () => {
  vi.stubEnv('SECOND_FIXTURE_KEY', 'fixture-second-5678');
  const doc = { version: 1, agents: {
    claude: { active: 'subscription', methods: { openrouter: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } },
    gemini: { active: 'apiKey', methods: { apiKey: { apiKeyEnv: 'SECOND_FIXTURE_KEY' } } },
    pi: { methods: { openrouter: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } },
  } };
  const inspect = vi.fn(async (runners?: string[]) => {
    expect(runners).toEqual(['claude']);
    expect(process.env.CEZ_TEST_PROVIDER).toBeUndefined();
    expect(process.env.SECOND_FIXTURE_KEY).toBeUndefined();
    return logins();
  });
  expect(await runProvidersCommand(['apply', JSON.stringify(doc), '--no-fetch'], { ...io, logins: inspect })).toBe(0);
  expect(inspect).toHaveBeenCalledOnce();
  expect((await readAgentProviders()).agents.claude?.active).toBe('subscription');
  expect(await readAgentProviderKey('pi', 'openrouter')).toBe(key);
  expect(process.env.CEZ_TEST_PROVIDER).toBe(key);
  expect(process.env.SECOND_FIXTURE_KEY).toBe('fixture-second-5678');
});

it('clears recognized key sources before serve continues after a rejected document', async () => {
  const invalid = { version: 1, agents: { gemini: { methods: { apiKey: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } }, typo: {} } };
  await expect(applyProvidersAtStartup(JSON.stringify(invalid))).rejects.toThrow('Invalid providers document');
  expect(process.env.CEZ_TEST_PROVIDER).toBeUndefined();
  expect(process.env.CEZ_HOME).toBe(home);
  expect((await readAgentProviders()).agents).toEqual({});
});

it('keeps a native host key active when importing it under its own name at startup', async () => {
  vi.stubEnv('GEMINI_API_KEY', key);
  const doc = { version: 1, agents: { gemini: { methods: { apiKey: { apiKeyEnv: 'GEMINI_API_KEY' } } } } };
  await applyProvidersAtStartup(JSON.stringify(doc));
  expect((await readAgentProviders()).agents.gemini?.active).toBe('apiKey');
  expect(await readAgentProviderKey('gemini', 'apiKey')).toBe(key);
  expect(process.env.GEMINI_API_KEY).toBeUndefined();
});
