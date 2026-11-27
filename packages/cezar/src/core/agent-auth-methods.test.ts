import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import registerGateway, { authMethods, providerLaunch } from './agent-auth-methods.ts';
import type { RunnerId } from './agent-runner.ts';

const key = 'synthetic-key-only';
const baseUrl = 'https://gateway.invalid/prefix/';
const model = 'org/model';
const options = { key, baseUrl, model };

describe('verified agent auth methods', () => {
  const matrix: Record<RunnerId, string[]> = {
    claude: ['subscription', 'openrouter', 'custom'], codex: ['subscription', 'openrouter', 'custom'],
    pi: ['anthropic', 'openai-codex', 'openrouter', 'custom'], omp: ['anthropic', 'openai-codex', 'openrouter', 'custom'],
    opencode: ['openai', 'openrouter', 'custom'], kimi: ['subscription', 'openrouter', 'custom'],
    gemini: ['apiKey'], cursor: ['subscription', 'apiKey'], antigravity: ['subscription'],
    copilot: ['subscription'], junie: ['subscription'],
  };

  for (const [name, ids] of Object.entries(matrix)) {
    const runner = name as RunnerId;
    it(`launches each advertised ${runner} method`, () => {
      const { mode, methods } = authMethods(runner);
      expect(methods.map(m => m.id)).toEqual(ids);
      expect(mode).toBe(['pi', 'omp', 'opencode'].includes(runner) ? 'any' : 'one');
      for (const method of methods) {
        const launch = providerLaunch(runner, method.id, options);
        expect(JSON.stringify([launch.argv, launch.codexConfig, launch.unsetEnv])).not.toContain(key);
        if (method.kind === 'subscription') {
          expect(Object.values(launch.env)).not.toContain(key);
          expect(launch.model).toBe(mode === 'any' ? `${method.id}/${model}` : model);
        } else {
          expect(Object.values(launch.env)).toContain(key);
          expect(() => providerLaunch(runner, method.id, { ...options, key: ' ' })).toThrow('key');
        }
      }
      expect(() => providerLaunch(runner, 'toString', options)).toThrow('Unsupported auth method');
    });
  }

  it('removes credentials and route selectors for an explicit Claude subscription', () => {
    const launch = providerLaunch('claude', 'subscription', { key });
    expect(launch.env).toEqual({});
    expect(launch.unsetEnv).toEqual(expect.arrayContaining([
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_BEDROCK',
    ]));
    expect(launch.unsetEnv).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it.each(['pi', 'omp', 'opencode'] as const)('preserves the subscription namespace exactly once for %s', (runner) => {
    const id = authMethods(runner).methods[0]!.id;
    expect(providerLaunch(runner, id, { model: id + '/native' }).model).toBe(id + '/native');
    expect(() => providerLaunch(runner, id, {})).toThrow('model');
  });

  it('selects the official Codex provider on subscription even when the home has a gateway default', () => {
    expect(providerLaunch('codex', 'subscription', {}).codexConfig).toMatchObject({ model_provider: 'openai' });
    expect(providerLaunch('codex', 'subscription', {}).unsetEnv).toContain('CODEX_API_KEY');
  });

  it.each(['openrouter', 'custom'] as const)('uses Anthropic, Responses and Chat Completions paths for %s', (id) => {
    const root = id === 'openrouter' ? 'https://openrouter.ai/api' : 'https://gateway.invalid/prefix';
    const claude = providerLaunch('claude', id, options);
    expect(claude.env).toEqual({ ANTHROPIC_BASE_URL: root, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' });
    expect(claude.unsetEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN');

    const codex = providerLaunch('codex', id, options);
    expect(codex).toMatchObject({ model, env: { CODEX_PROVIDER_API_KEY: key }, codexConfig: {
      model_provider: 'cezar', 'model_providers.cezar': { base_url: root + '/v1', env_key: 'CODEX_PROVIDER_API_KEY', wire_api: 'responses' },
    } });

    const open = providerLaunch('opencode', id, options);
    const provider = open.model!.split('/')[0]!;
    expect(provider).toMatch(/^cezar-/);
    const variable = id === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENCODE_PROVIDER_API_KEY';
    const config = JSON.parse(open.env.OPENCODE_CONFIG_CONTENT!);
    expect(open.model).toBe(provider + '/' + model);
    expect(config).toMatchObject({ enabled_providers: [provider], model: open.model, provider: { [provider]: {
      npm: '@ai-sdk/openai-compatible', options: { baseURL: root + '/v1', apiKey: '{env:' + variable + '}' }, models: { [model]: { name: model } },
    } } });
    expect(open.env.OPENCODE_CONFIG_CONTENT).not.toContain(key);

    const kimi = providerLaunch('kimi', id, options);
    expect(kimi.env).toEqual({ KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_API_KEY: key,
      KIMI_MODEL_BASE_URL: root + '/v1', KIMI_MODEL_NAME: model });
    expect(kimi.model).toBe('__kimi_env_model__');
    expect(kimi.argv).toBeUndefined();
  });

  it.each(['pi', 'omp'] as const)('registers a private %s provider with an env reference and the exact remote model', (runner) => {
    const launch = providerLaunch(runner, 'custom', options);
    expect(launch.argv).toEqual(['-e', fileURLToPath(new URL('./agent-auth-methods.ts', import.meta.url))]);
    const provider = launch.env.PI_CEZAR_GATEWAY_PROVIDER;
    expect(launch.model).toBe(provider + '/' + model);
    expect(providerLaunch(runner, 'custom', options).env.PI_CEZAR_GATEWAY_PROVIDER).not.toBe(provider);
    try {
      for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value);
      const registerProvider = vi.fn();
      registerGateway({ registerProvider });
      expect(registerProvider).toHaveBeenCalledWith(provider, expect.objectContaining({
        api: 'openai-completions', baseUrl: 'https://gateway.invalid/prefix/v1',
        apiKey: runner === 'pi' ? '$PI_CEZAR_GATEWAY_KEY' : 'PI_CEZAR_GATEWAY_KEY',
        models: [expect.objectContaining({ id: model })],
      }));
      expect(JSON.stringify(registerProvider.mock.calls)).not.toContain(key);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('confirms OMP OAuth only after restricting the native session to vendor-owned OAuth identities', () => {
    const launch = providerLaunch('omp', 'anthropic', { model: 'claude' });
    const restrict = vi.fn(() => Symbol());
    const source = vi.fn(() => ({ kind: 'config' }));
    const ctx = {
      model: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com' },
      sessionManager: { getSessionId: () => 'session-id' },
      modelRegistry: { authStorage: { keys: { source }, oauth: { accounts: () => [{ email: 'Test@example.invalid', orgId: 'id' }] },
        sessions: { restrict } } },
    };
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value);
      const run = () => registerGateway({ registerProvider: vi.fn(), on: (_type, fn) => fn({}, ctx) });
      run();
      expect(restrict).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      source.mockReturnValue({ kind: 'oauth' });
      ctx.model.baseUrl = 'https://gateway.invalid/v1';
      run();
      expect(write).not.toHaveBeenCalled();
      ctx.model.baseUrl = 'https://api.anthropic.com';
      run();
      expect(restrict).toHaveBeenCalledWith('anthropic', 'session-id', ['email:test@example.invalid|org:id']);
      expect(write).toHaveBeenCalledWith(`cezar-omp-oauth:${launch.env.OMP_CEZAR_OAUTH_CHECK}\n`);
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('marks native host keys only on agents that read them without a managed launch', () => {
    for (const runner of ['pi', 'omp', 'opencode', 'codex', 'claude', 'kimi'] as const) {
      const method = authMethods(runner).methods.find(m => m.id === 'openrouter');
      expect(method?.hostKeyEnv).toBe(['pi', 'omp', 'opencode'].includes(runner) ? 'OPENROUTER_API_KEY' : undefined);
    }
  });

  it('keeps a slash that belongs to the remote model name', () => {
    expect(providerLaunch('opencode', 'openrouter', { key, model: 'openrouter/auto' }).model).toMatch(/^cezar-[^/]+\/openrouter\/auto$/);
  });

  it('rejects inline OpenCode substitutions in untrusted catalog ids', () => {
    expect(() => providerLaunch('opencode', 'custom', { ...options, model: '{file:anything}' })).toThrow('model ID');
  });

  it('keeps keys from being sent to invalid custom endpoints', () => {
    for (const invalid of ['', 'http://public.invalid', 'https://name:pass@example.com', 'https://example.com/?q=1', 'http://127.bad.local']) {
      expect(() => providerLaunch('codex', 'custom', { key, baseUrl: invalid })).toThrow('base URL');
    }
    expect(providerLaunch('claude', 'custom', { key, baseUrl: 'http://[::1]:9876/prefix/' }).env.ANTHROPIC_BASE_URL)
      .toBe('http://[::1]:9876/prefix');
  });

  it.each([['cursor', 'CURSOR_API_KEY'], ['gemini', 'GEMINI_API_KEY']] as const)('uses the %s native key', (runner, name) => {
    expect(authMethods(runner).methods.find(m => m.kind === 'apiKey')?.hostKeyEnv).toBe(name);
    expect(providerLaunch(runner, 'apiKey', options).env).toEqual({ [name]: key });
  });
});
