import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyProvidersAtStartup, prepareProvidersDocument, runProvidersCommand } from './agent-providers-cli.ts';
import { readAgentProviders, readAgentProviderKey } from './workspace/agent-providers.ts';
import * as keyring from './workspace/secret-keyring.ts';
import * as models from './agent-providers/models.ts';

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
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

it('applies inputs atomically, preserving unnamed methods and never printing the key', async () => {
  const doc = { version: 1, agents: { claude: { methods: { openrouter: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } }, active: 'openrouter' } } };
  expect(await runProvidersCommand(['set', 'codex', 'custom', '--base-url', 'https://example.test', '--key-stdin', '--active'], io)).toBe(0);
  expect(await runProvidersCommand(['apply', JSON.stringify(doc)], io)).toBe(0);
  const first = await readAgentProviders();
  expect(first.agents.claude).toMatchObject({ active: 'openrouter', methods: { openrouter: { keyHint: '…1234', origin: 'file' } } });
  expect(await readAgentProviderKey('codex', 'custom')).toBe(key);
  // Each command would inherit a fresh copy from its calling shell.
  vi.stubEnv('CEZ_TEST_PROVIDER', key);
  expect(await runProvidersCommand(['apply', JSON.stringify(doc), '--no-fetch'], io)).toBe(0);
  expect(await readAgentProviders()).toEqual(first);
  const bad = { ...doc, agents: { ...doc.agents, cursor: { methods: { custom: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } } } };
  vi.stubEnv('CEZ_TEST_PROVIDER', key);
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
  expect(process.env.CEZ_TEST_PROVIDER).toBeUndefined();
  vi.stubEnv('CEZ_TEST_PROVIDER', key);
  expect(await runProvidersCommand(['set', 'gemini', 'apiKey', '--key-env', 'CEZ_TEST_PROVIDER', '--no-fetch'], noProbe)).toBe(0);
  const additive = { version: 1, agents: { pi: { methods: { openrouter: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } } } };
  vi.stubEnv('CEZ_TEST_PROVIDER', key);
  expect(await runProvidersCommand(['apply', JSON.stringify(additive), '--no-fetch'], noProbe)).toBe(0);
  expect(noProbe.logins).not.toHaveBeenCalled();
  expect(await readAgentProviderKey('pi', 'openrouter')).toBe(key);
  expect(process.env.CEZ_TEST_PROVIDER).toBeUndefined();
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
  expect(process.env.CEZ_TEST_PROVIDER).toBeUndefined();
  expect(process.env.SECOND_FIXTURE_KEY).toBeUndefined();
});

it('clears recognized key sources before serve continues after a rejected document', async () => {
  const invalid = { version: 1, agents: { gemini: { methods: { apiKey: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } }, typo: {} } };
  await expect(prepareProvidersDocument(JSON.stringify(invalid))).rejects.toThrow('Invalid providers document');
  expect(process.env.CEZ_TEST_PROVIDER).toBeUndefined();
  expect(process.env.CEZ_HOME).toBe(home);
  expect((await readAgentProviders()).agents).toEqual({});
});

it.each(['inline', 'file'])('discards only the explicitly declared sources in malformed %s startup JSON', async (input) => {
  vi.stubEnv('SECOND_FIXTURE_KEY', 'fixture-second-5678');
  vi.stubEnv('UNRELATED_CONTROL', 'keep');
  vi.stubEnv('true', 'keep');
  const invalid = JSON.stringify({ version: 1, agents: {
    claude: { methods: { custom: { apiKeyEnv: 'CEZ_TEST_PROVIDER', label: '"apiKeyEnv": "UNRELATED_CONTROL"' } } },
    gemini: { methods: { apiKey: { apiKeyEnv: 'SECOND_FIXTURE_KEY' } } },
    pi: { methods: { openrouter: { apiKeyEnv: true } } },
  }, unrelated: { apiKeyEnv: 'UNRELATED_CONTROL' } }).slice(0, -1) + ',}';
  const source = input === 'file' ? join(home, 'providers.json') : invalid;
  if (input === 'file') await writeFile(source, invalid);
  await expect(prepareProvidersDocument(source)).rejects.toThrow('Invalid providers JSON or YAML');
  expect(process.env.CEZ_TEST_PROVIDER).toBeUndefined();
  expect(process.env.SECOND_FIXTURE_KEY).toBeUndefined();
  expect(process.env.UNRELATED_CONTROL).toBe('keep');
  expect(process.env.true).toBe('keep');
  expect((await readAgentProviders()).agents).toEqual({});
});

it('keeps declared sources out of keyring reads, writes and model refresh', async () => {
  vi.stubEnv('SECOND_FIXTURE_KEY', 'fixture-second-5678');
  vi.stubEnv('UNRELATED_CONTROL', 'keep');
  const observed: { operation: string; first: boolean; second: boolean; control?: string }[] = [];
  function observe(operation: string) {
    observed.push({ operation, first: Object.hasOwn(process.env, 'CEZ_TEST_PROVIDER'),
      second: Object.hasOwn(process.env, 'SECOND_FIXTURE_KEY'), control: process.env.UNRELATED_CONTROL });
  }
  let dataKey: Buffer | null = null;
  vi.spyOn(keyring, 'osKeychain').mockResolvedValue({
    async get() { observe('keyring read'); return dataKey; },
    async set(value) { observe('keyring write'); dataKey = value; },
  });
  vi.spyOn(models, 'fetchProviderModels').mockImplementation(async () => {
    observe('models');
    return [{ id: 'fixture-model' }];
  });
  const doc = { version: 1, agents: {
    claude: { methods: { openrouter: { apiKeyEnv: 'CEZ_TEST_PROVIDER' } } },
    gemini: { active: 'apiKey', methods: { apiKey: { apiKeyEnv: 'SECOND_FIXTURE_KEY' } } },
  } };
  const cli = { ...io, logins: async () => { observe('login'); return logins(); } };
  expect(await runProvidersCommand(['apply', JSON.stringify(doc)], cli)).toBe(0);
  expect(await readAgentProviderKey('claude', 'openrouter')).toBe(key);
  expect(await readAgentProviderKey('gemini', 'apiKey')).toBe('fixture-second-5678');
  expect(new Set(observed.map(row => row.operation))).toEqual(new Set(['login', 'keyring read', 'keyring write', 'models']));
  for (const row of observed) expect(row, row.operation).toMatchObject({ first: false, second: false, control: 'keep' });
});

it('keeps a native host key active when importing it under its own name at startup', async () => {
  vi.stubEnv('GEMINI_API_KEY', key);
  const doc = { version: 1, agents: { gemini: { methods: { apiKey: { apiKeyEnv: 'GEMINI_API_KEY' } } } } };
  await applyProvidersAtStartup(await prepareProvidersDocument(JSON.stringify(doc)));
  expect((await readAgentProviders()).agents.gemini?.active).toBe('apiKey');
  expect(await readAgentProviderKey('gemini', 'apiKey')).toBe(key);
  expect(process.env.GEMINI_API_KEY).toBeUndefined();
});

it('joins without reading owner status for edits resolved entirely by the provider store', async () => {
  const owner = 'http://127.0.0.1:4321';
  const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Native login still warming'));
  const join = async (agents: object) => applyProvidersAtStartup(
    await prepareProvidersDocument(JSON.stringify({ version: 1, agents })), owner,
  );
  await join({ codex: { active: 'custom', methods: { custom: { baseUrl: 'https://gateway.test', apiKeyEnv: 'CEZ_TEST_PROVIDER' } } } });
  await join({ codex: { methods: { custom: { label: 'Team gateway' } } } });
  await join({ gemini: { active: null } });
  expect(request).not.toHaveBeenCalled();
  const { agents } = await readAgentProviders();
  expect(agents.codex).toMatchObject({ active: 'custom', methods: { custom: { label: 'Team gateway' } } });
  expect(agents.gemini?.active).toBeNull();
  expect(await readAgentProviderKey('codex', 'custom')).toBe(key);
});

it('discards a prepared import when the serving cockpit cannot confirm its native method', async () => {
  expect(await runProvidersCommand(['set', 'codex', 'custom', '--base-url', 'http://127.0.0.1:9000',
    '--key-env', 'CEZ_TEST_PROVIDER', '--active', '--no-fetch'], io)).toBe(0);
  const prior = await readFile(join(home, 'agent-providers.json'), 'utf8');
  vi.stubEnv('GOOGLE_API_KEY', 'joiner-only-fixture');
  vi.stubEnv('GEMINI_API_KEY', 'undeclared-joiner-fixture');
  const prepared = await prepareProvidersDocument(JSON.stringify({ version: 1, agents: {
    codex: { active: 'custom', methods: { custom: { apiKeyEnv: 'GOOGLE_API_KEY', label: 'replacement' } } },
    gemini: { active: 'apiKey' },
  } }));
  expect(process.env.GOOGLE_API_KEY).toBeUndefined();
  expect(await readFile(join(home, 'agent-providers.json'), 'utf8')).toBe(prior);
  const owner = 'http://127.0.0.1:4321';
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(applyProvidersAtStartup(prepared, owner)).rejects.toThrow(/running cockpit.*retry/i);
  request.mockResolvedValueOnce(Response.json({ editable: true, agents: [
    { runner: 'codex', mode: 'one', methods: [] },
    { runner: 'gemini', mode: 'one', methods: [{ id: 'apiKey', kind: 'apiKey', label: 'Gemini key', state: 'disconnected' }] },
  ] }));
  await expect(applyProvidersAtStartup(prepared, owner)).rejects.toThrow(/gemini\/apiKey.*running cockpit/i);
  for (const [url, options] of request.mock.calls) {
    expect(String(url)).toBe(owner + '/api/v1/agent-providers');
    expect(options?.method ?? 'GET').toBe('GET');
    expect(options?.body).toBeUndefined();
  }
  expect(await readFile(join(home, 'agent-providers.json'), 'utf8')).toBe(prior);
  expect(await readAgentProviderKey('codex', 'custom')).toBe(key);
  expect(await readAgentProviderKey('gemini', 'apiKey')).toBeUndefined();
});

it.each(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])('retains %s only for the explicitly selected host method after a successful startup', async source => {
  // Each startup owns its captured credentials for the lifetime of that server.
  vi.resetModules();
  const { applyProvidersAtStartup, prepareProvidersDocument } = await import('./agent-providers-cli.ts');
  const startup = async (source: string) => applyProvidersAtStartup(await prepareProvidersDocument(source));
  const { authMethods, providerHostKey, providerLaunch } = await import('./core/agent-auth-methods.ts');
  const gemini = authMethods('gemini').methods.find(method => method.id === 'apiKey')!;
  const cursor = authMethods('cursor').methods.find(method => method.id === 'apiKey')!;
  vi.stubEnv('GEMINI_API_KEY', undefined);
  vi.stubEnv('GOOGLE_API_KEY', undefined);
  const agents = {
    gemini: { active: 'apiKey' },
    codex: { active: 'custom', methods: { custom: { baseUrl: 'https://gateway.test', apiKeyEnv: source } } },
    pi: { methods: { openrouter: { apiKeyEnv: 'CURSOR_API_KEY' } } },
  };
  vi.stubEnv(source, key);
  vi.stubEnv('CURSOR_API_KEY', 'other-provider-fixture');
  await expect(startup(JSON.stringify({ version: 1, agents: { ...agents, junie: { active: 'custom' } } }))).rejects.toThrow();
  expect(providerHostKey('gemini', gemini)).toBeUndefined();
  expect((await readAgentProviders()).agents).toEqual({});

  for (let invocation = 0; invocation < 2; invocation++) {
    vi.stubEnv(source, key);
    vi.stubEnv('CURSOR_API_KEY', 'other-provider-fixture');
    await startup(JSON.stringify({ version: 1, agents }));
    expect(process.env[source]).toBeUndefined();
    expect(process.env.CURSOR_API_KEY).toBeUndefined();
    expect(providerHostKey('cursor', cursor)).toBeUndefined();
    const stored = await readAgentProviders();
    expect(stored.agents.gemini).toEqual({ active: 'apiKey', methods: {} });
    expect(stored.agents.codex?.active).toBe('custom');
    expect(await readAgentProviderKey('codex', 'custom')).toBe(key);
    expect(providerLaunch('gemini', 'apiKey', { key: providerHostKey('gemini', gemini) }).env).toEqual({ GEMINI_API_KEY: key });
  }
});
