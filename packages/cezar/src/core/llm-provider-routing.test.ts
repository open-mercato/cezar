import { buildChildEnv } from './agent-env.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { routeLlmProvider } from './llm-provider-routing.ts';
import { normalizeModelForBackend } from './model-identity.ts';
import { parsePiModels } from './pi-model-catalog.ts';
import type { AgentRunSpec } from './agent-runner.ts';

const provider = {
  id: '12345678-1234-4234-8234-123456789abc',
  name: 'OpenRouter',
  kind: 'openrouter' as const,
  protocol: 'openai-completions' as const,
  baseUrl: 'https://openrouter.ai/api/v1',
};
const spec: AgentRunSpec = {
  cwd: '/repo',
  userPrompt: 'task',
  model: 'anthropic/claude-sonnet-4.6',
  env: { KEEP: 'yes' },
  llmProvider: { provider, apiKey: 'test-only-secret-123456' },
};

it('leaves every native subscription path untouched and refuses missing external models / unsupported runners', () => {
  const native = { cwd: '/repo', userPrompt: 'task' };
  expect(routeLlmProvider('claude', native)).toBe(native);
  expect(() => routeLlmProvider('cursor', spec)).toThrow('not compatible');
  expect(() => routeLlmProvider('pi', { ...spec, model: undefined })).toThrow(
    'Select a model',
  );
});

it.each(['claude', 'codex', 'pi', 'opencode', 'copilot', 'junie'] as const)(
  '%s routes only the selected connection without persisting the key',
  (runner) => {
    const routed = routeLlmProvider(runner, spec);
    expect(routed.env?.LLM_API_KEY).toBe(spec.llmProvider?.apiKey);
    expect(routed.env?.KEEP).toBe('yes');
    expect(routed.onUsageWindows).toBeUndefined();
    if (runner === 'claude') {
      expect(routed.env?.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
      expect(routed.env?.ANTHROPIC_API_KEY).toBe('');
      expect(routed.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    }
    if (runner === 'codex') {
      const config = readFileSync(
        join(routed.env!.CODEX_HOME!, 'config.toml'),
        'utf8',
      );
      expect(config).toContain('env_key = "LLM_API_KEY"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).not.toContain(spec.llmProvider!.apiKey);
    }
    if (runner === 'pi') {
      expect(routed.model).toBe(`cezar/${spec.model}`);
      expect(
        readFileSync(
          join(routed.env!.PI_CODING_AGENT_DIR!, 'models.json'),
          'utf8',
        ),
      ).not.toContain(spec.llmProvider!.apiKey);
    }
    if (runner === 'opencode') {
      expect(JSON.parse(routed.env!.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
        enabled_providers: ['cezar'],
        provider: { cezar: { options: { apiKey: '{env:LLM_API_KEY}' } } },
      });
    }
    if (runner === 'copilot') {
      expect(routed.env?.COPILOT_OFFLINE).toBe('true');
      expect(routed.env?.COPILOT_PROVIDER_WIRE_MODEL).toBe(spec.model);
      expect(routed.env?.GH_TOKEN).toBe('');
    }
    if (runner === 'junie') {
      expect(routed.model).toMatch(/^custom:cezar-/);
      const config = readFileSync(
        join(
          routed.env!.JUNIE_MODEL_LOCATIONS!,
          `${routed.model!.slice(7)}.json`,
        ),
        'utf8',
      );
      expect(JSON.parse(config)).toMatchObject({
        id: spec.model,
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '${LLM_API_KEY}',
      });
    }
  },
);

it('preserves provider-native model IDs for API connections without weakening native identity validation', () => {
  expect(
    normalizeModelForBackend('copilot', 'anthropic/claude-sonnet-4.6', {
      llmProviderId: provider.id,
    }),
  ).toMatchObject({
    backendModel: 'anthropic/claude-sonnet-4.6',
    identity: { provider: `llm:${provider.id}` },
  });
  expect(() =>
    normalizeModelForBackend('copilot', 'anthropic/claude-sonnet-4.6'),
  ).toThrow();
});

it('parses both providers and slash-containing Pi model IDs, ignoring headers / diagnostics', () => {
  expect(
    parsePiModels(
      'provider model context max-out thinking images\nopenrouter anthropic/claude-sonnet-4.6 1M 128K yes yes\nopenai gpt-example 128K 8K no no\nnot a model\n',
    ),
  ).toMatchObject([
    { id: 'openrouter/anthropic/claude-sonnet-4.6' },
    { id: 'openai/gpt-example' },
  ]);
});

it('keeps native API credentials out of an explicitly selected provider process, including full-env mode', () => {
  const routed = routeLlmProvider('pi', spec);
  const env = buildChildEnv({
    backend: 'pi',
    extraEnv: routed.env,
    source: {
      CEZ_AGENT_ENV_FULL: '1',
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'unrelated-native-key',
      OPENROUTER_API_KEY: 'unrelated-account-key',
    },
  });
  expect(env.LLM_API_KEY).toBe(spec.llmProvider!.apiKey);
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.OPENROUTER_API_KEY).toBeUndefined();
  expect(env.PATH).toBe('/bin');
});

it('uses Anthropic authentication for a custom Messages endpoint and the SDK base path for Pi', () => {
  const custom = {
    ...spec,
    llmProvider: {
      ...spec.llmProvider!,
      provider: {
        ...provider,
        kind: 'custom' as const,
        protocol: 'anthropic-messages' as const,
        baseUrl: 'https://gateway.example/v1',
      },
    },
  };
  const claude = routeLlmProvider('claude', custom);
  expect(claude.env?.ANTHROPIC_API_KEY).toBe(spec.llmProvider!.apiKey);
  expect(claude.env?.ANTHROPIC_AUTH_TOKEN).toBe('');
  const pi = routeLlmProvider('pi', custom);
  expect(
    JSON.parse(
      readFileSync(join(pi.env!.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'),
    ).providers.cezar.baseUrl,
  ).toBe('https://gateway.example');
});
