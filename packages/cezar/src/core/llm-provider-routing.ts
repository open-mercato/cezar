import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { atomicTmpPath, atomicWriteJsonSync } from '../workspace/config.ts';
import { renameSyncWithRetry } from '../fs-rename.ts';
import { join } from 'node:path';
import type { AgentRunSpec, AgentBackend } from './agent-runner.ts';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { supportsLlmProvider } from '@open-mercato/cezar-contract';

/** Only the explicitly selected connection reaches this process; native launches are untouched. */
export function routeLlmProvider(
  backend: AgentBackend,
  spec: AgentRunSpec,
): AgentRunSpec {
  const selected = spec.llmProvider;
  if (!selected) return spec;
  const { provider, apiKey } = selected;
  if (!supportsLlmProvider(backend, provider))
    throw new Error(`This LLM provider is not compatible with ${backend}`);
  if (!spec.model?.trim())
    throw new Error(
      'Select a model for this LLM provider; native model defaults are not used.',
    );
  const home = join(cezarHomeDir(), 'llm-agent-homes', provider.id, backend);
  assertCezarHomeWriteIsSandboxed(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256')
    .update(spec.model)
    .digest('hex')
    .slice(0, 24);
  const configHome = backend === 'codex' ? home : join(home, hash);
  mkdirSync(configHome, { recursive: true, mode: 0o700 });
  const file = (name: string, contents: unknown) => {
    const path = join(configHome, name);
    if (typeof contents !== 'string')
      return atomicWriteJsonSync(path, contents);
    const temp = atomicTmpPath(path);
    writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
    try {
      renameSyncWithRetry(temp, path);
    } catch (error) {
      unlinkSync(temp);
      throw error;
    }
  };
  const env: Record<string, string> = { ...spec.env, LLM_API_KEY: apiKey };
  let model = spec.model;
  switch (backend) {
    case 'claude':
    case 'claude-cli':
      Object.assign(env, {
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: provider.baseUrl.replace(/\/v1$/, ''),
        ANTHROPIC_AUTH_TOKEN: provider.kind === 'openrouter' ? apiKey : '',
        ANTHROPIC_API_KEY: provider.kind === 'openrouter' ? '' : apiKey,
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
      });
      break;
    case 'codex':
      file(
        'config.toml',
        `model_provider = "cezar-llm"\n[model_providers.cezar-llm]\nname = "Cezar LLM provider"\nbase_url = ${JSON.stringify(provider.baseUrl)}\nenv_key = "LLM_API_KEY"\nwire_api = "responses"\n`,
      );
      Object.assign(env, {
        CODEX_HOME: configHome,
        OPENAI_API_KEY: '',
        CODEX_API_KEY: '',
      });
      break;
    case 'pi': {
      const sessions = join(home, 'sessions');
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      file('models.json', {
        providers: {
          cezar: {
            baseUrl:
              provider.protocol === 'anthropic-messages'
                ? provider.baseUrl.replace(/\/v1$/, '')
                : provider.baseUrl,
            apiKey: 'LLM_API_KEY',
            api: provider.protocol,
            models: [{ id: model }],
          },
        },
      });
      Object.assign(env, {
        PI_CODING_AGENT_DIR: configHome,
        PI_CODING_AGENT_SESSION_DIR: sessions,
      });
      model = `cezar/${model}`;
      break;
    }
    case 'opencode': {
      let config: Record<string, unknown> & {
        provider?: Record<string, unknown>;
      };
      try {
        config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
        if (!config || typeof config !== 'object' || Array.isArray(config))
          throw new Error();
      } catch {
        throw new Error('Invalid OpenCode inline configuration');
      }
      Object.assign(config, {
        enabled_providers: ['cezar'],
        provider: {
          ...config.provider,
          cezar: {
            npm:
              provider.protocol === 'anthropic-messages'
                ? '@ai-sdk/anthropic'
                : provider.protocol === 'openai-responses'
                  ? '@ai-sdk/openai'
                  : '@ai-sdk/openai-compatible',
            name: provider.name,
            options: { baseURL: provider.baseUrl, apiKey: '{env:LLM_API_KEY}' },
            models: { [model]: { name: model } },
          },
        },
      });
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      model = `cezar/${model}`;
      break;
    }
    case 'copilot':
      file('providers.json', {});
      Object.assign(env, {
        COPILOT_HOME: home,
        COPILOT_PROVIDERS_CONFIG: join(configHome, 'providers.json'),
        COPILOT_PROVIDER_TYPE:
          provider.protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
        COPILOT_PROVIDER_BASE_URL:
          provider.protocol === 'anthropic-messages'
            ? provider.baseUrl.replace(/\/v1$/, '')
            : provider.baseUrl,
        COPILOT_PROVIDER_API_KEY: apiKey,
        COPILOT_PROVIDER_BEARER_TOKEN: '',
        COPILOT_PROVIDER_API_KEY_COMMAND: '',
        COPILOT_PROVIDER_HEADERS: '',
        COPILOT_PROVIDER_MODEL_ID: model,
        COPILOT_PROVIDER_WIRE_MODEL: model,
        COPILOT_PROVIDER_WIRE_API:
          provider.protocol === 'openai-responses'
            ? 'responses'
            : 'completions',
        COPILOT_PROVIDER_TRANSPORT: 'http',
        COPILOT_MODEL: model,
        COPILOT_OFFLINE: 'true',
        COPILOT_GITHUB_TOKEN: '',
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      });
      break;
    case 'junie': {
      const profile = `cezar-${hash}`;
      file(`${profile}.json`, {
        id: model,
        baseUrl: `${provider.baseUrl}/${provider.protocol === 'anthropic-messages' ? 'messages' : provider.protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`,
        apiType:
          provider.protocol === 'anthropic-messages'
            ? 'Anthropic'
            : provider.protocol === 'openai-responses'
              ? 'OpenAIResponses'
              : 'OpenAICompletion',
        apiKey: '${LLM_API_KEY}',
        displayName: model,
        providerName: provider.name,
      });
      Object.assign(env, {
        JUNIE_HOME: home,
        JUNIE_MODEL_LOCATIONS: configHome,
        JUNIE_MODEL_DEFAULT_LOCATIONS: 'false',
        JUNIE_MODEL: `custom:${profile}`,
      });
      model = `custom:${profile}`;
      break;
    }
  }
  return { ...spec, model, env, onUsageWindows: undefined };
}
