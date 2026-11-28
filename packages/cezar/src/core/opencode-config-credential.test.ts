import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opencodeHasUserConfigCredential, opencodeUserModelVariants } from './opencode-config-credential.ts';
import { ProviderAuthService } from './provider-auth.ts';

let home: string;
let configDir: string;
let env: NodeJS.ProcessEnv;

function provider(key: unknown = 'fixture-key') {
  return {
    package: '@ai-sdk/openai-compatible',
    settings: { baseURL: 'https://models.example.test/v1', apiKey: key },
    models: { 'custom-model': {} },
  };
}

function write(config: unknown, name = 'opencode.jsonc') {
  writeFileSync(join(configDir, name), typeof config === 'string' ? config : JSON.stringify(config));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-opencode-credential-'));
  configDir = join(home, '.config', 'opencode');
  mkdirSync(configDir, { recursive: true });
  env = { HOME: home };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('trusted OpenCode 2.x user config credential evidence', () => {
  it('recognizes both local providers from JSONC with comments and trailing commas', () => {
    write(`{
      // Native OpenCode 2.x provider settings
      "providers": {
        "compatible-provider": ${JSON.stringify(provider())},
        "custom-provider": ${JSON.stringify({ ...provider(), models: { 'reasoning-model': {} } })},
      },
    }`);
    expect(opencodeHasUserConfigCredential(env)).toBe(true);
  });

  it('follows XDG_CONFIG_HOME, without reading project or home-root config', () => {
    write({ providers: { local: provider() } });
    writeFileSync(join(home, 'opencode.jsonc'), JSON.stringify({ providers: { project: provider() } }));
    const elsewhere = join(home, 'xdg');
    mkdirSync(join(elsewhere, 'opencode'), { recursive: true });
    expect(opencodeHasUserConfigCredential({ ...env, XDG_CONFIG_HOME: elsewhere })).toBe(false);
  });

  it('merges JSON then JSONC with the native precedence, including credential removal', () => {
    write({ providers: { local: provider() } }, 'opencode.json');
    write({ providers: { local: { settings: { apiKey: '' } } } });
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
    write({ providers: { local: { name: 'Local model' } } });
    expect(opencodeHasUserConfigCredential(env)).toBe(true);
  });

  it('ignores the unsupported config.json filename', () => {
    write({ providers: { local: provider() } }, 'config.json');
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
  });

  it('keeps a valid provider available beside a provider with an invalid URL', () => {
    write({ providers: {
      invalid: { ...provider(), settings: { apiKey: 'fixture-key', baseURL: 'invalid URL' } },
      local: provider(),
    } });
    expect(opencodeHasUserConfigCredential(env)).toBe(true);
  });

  it.each([
    { disabled_providers: ['local'] },
    { enabled_providers: [] },
    { enabled_providers: ['another'] },
    { enabled_providers: 'local' },
    { disabled_providers: [null] },
  ])('respects provider filters %j', (filters) => {
    write({ providers: { local: provider() }, ...filters });
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
  });

  it('requires an enabled model', () => {
    write({ providers: { local: { ...provider(), models: { glm: { disabled: true } } } } });
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
    write({ providers: { local: { ...provider(), models: {} } } });
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
  });

  it.each(['', '  ', null, '{env:MISSING_KEY}', 'prefix-{env:MISSING_KEY}', '{file:private-key}', '{env:}', '${API_KEY}'])('rejects missing or unresolved keys %j', (key) => {
    write({ providers: { local: provider(key) } });
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
  });

  it('resolves only environment keys that the native runner receives', () => {
    write({ providers: { local: provider('{env:LOCAL_LLM_API_KEY}') } });
    const withKey = { ...env, LOCAL_LLM_API_KEY: 'fixture-key' };
    expect(opencodeHasUserConfigCredential(withKey)).toBe(false);
    expect(opencodeHasUserConfigCredential({ ...withKey, CEZ_ENV_PASSTHROUGH: 'LOCAL_LLM_API_KEY' })).toBe(true);
    write({ providers: { local: provider('{env:OPENAI_API_KEY}') } });
    expect(opencodeHasUserConfigCredential({ ...env, OPENAI_API_KEY: 'fixture-key' })).toBe(true);
  });

  it.each([
    '{"providers":',
    '[]',
    { providers: { cloud: { ...provider(), package: '@ai-sdk/openai' } } },
    { providers: { local: { ...provider(), settings: { apiKey: 'fixture-key' } } } },
    { providers: { local: { ...provider(), settings: { apiKey: 'fixture-key', baseURL: 'file:///private' } } } },
    { provider: { local: { options: { apiKey: 'fixture-key' } } } },
  ])('does not infer credentials from unsupported or malformed config %j', (config) => {
    write(config);
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
  });

  it('does not mutate prototypes while merging user-controlled provider names', () => {
    write('{"providers":{"__proto__":{"settings":{"apiKey":"fixture-key"}}}}');
    expect(opencodeHasUserConfigCredential(env)).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'settings')).toBe(false);
  });

  it('offers native effort and explicit variants without inventing generic effort levels', () => {
    write({ providers: { local: { ...provider(), models: {
      qwen: { capabilities: { reasoning: { supported: true, effort: ['low', 'medium', 'xhigh'] } } },
      glm: { capabilities: { reasoning: { supported: true, effort: ['low', 'high', 'max'] } }, variants: [{ id: 'compact' }, { id: 'low' }, { id: '{bad}' }] },
      disabled: { disabled: true, variants: [{ id: 'low' }] },
    } } } });
    expect([...opencodeUserModelVariants(env)]).toEqual([
      ['local/qwen', ['low', 'medium', 'xhigh']],
      ['local/glm', ['low', 'high', 'max', 'compact']],
    ]);
  });
});

describe('OpenCode auth status supplement', () => {
  it.each(['No authenticated integrations\n', '[]\n'])('accepts inline credentials when auth-list omits them: %s', async (stdout) => {
    write({ providers: { local: provider() } });
    const service = new ProviderAuthService({ env, runCommand: async () => ({ stdout, stderr: '', exitCode: 0 }) });
    const row = (await service.status()).providers.find((item) => item.provider === 'opencode');
    expect(row?.status).toBe('connected');
  });

  it.each([
    { stdout: '{broken', stderr: '', exitCode: 0 },
    { stdout: '', stderr: 'Error: Cannot start server', exitCode: 1 },
    { stdout: '', stderr: '', exitCode: null, errorCode: 'ENOENT' },
    { stdout: '┌ Credentials auth.json\n└ 0 credentials', stderr: '', exitCode: 0 },
  ])('preserves authoritative failure/legacy classifications %j', async (answer) => {
    write({ providers: { local: provider() } });
    const service = new ProviderAuthService({ env, runCommand: async () => answer });
    const row = (await service.status()).providers.find((item) => item.provider === 'opencode');
    expect(row?.status).not.toBe('connected');
  });
});
