import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RunnerId } from './agent-runner.ts';

type MethodKind = 'subscription' | 'openrouter' | 'custom' | 'apiKey';

interface AuthMethod {
  id: string;
  kind: MethodKind;
  label: string;
  hostKeyEnv?: string;
}

interface Capabilities {
  mode: 'one' | 'any';
  methods: readonly AuthMethod[];
}

const subscription = (label: string, id = 'subscription'): AuthMethod => ({ id, kind: 'subscription', label });
const openrouter: AuthMethod = { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter' };
const nativeOpenrouter: AuthMethod = { ...openrouter, hostKeyEnv: 'OPENROUTER_API_KEY' };
const custom: AuthMethod = { id: 'custom', kind: 'custom', label: 'Custom endpoint' };
const apiKey = (label: string, hostKeyEnv: string): AuthMethod => ({ id: 'apiKey', kind: 'apiKey', label, hostKeyEnv });
const piMethods = [
  subscription('Claude subscription', 'anthropic'), subscription('ChatGPT subscription', 'openai-codex'), nativeOpenrouter, custom,
];

const capabilities: Record<RunnerId, Capabilities> = {
  claude: { mode: 'one', methods: [subscription('Claude subscription'), openrouter, custom] },
  codex: { mode: 'one', methods: [subscription('ChatGPT subscription'), openrouter, custom] },
  pi: { mode: 'any', methods: piMethods },
  omp: { mode: 'any', methods: piMethods },
  opencode: { mode: 'any', methods: [subscription('ChatGPT subscription', 'openai'), nativeOpenrouter, custom] },
  kimi: { mode: 'one', methods: [subscription('Kimi Code subscription'), openrouter, custom] },
  gemini: { mode: 'one', methods: [apiKey('Gemini API key', 'GEMINI_API_KEY')] },
  cursor: { mode: 'one', methods: [subscription('Cursor account'), apiKey('Cursor API key', 'CURSOR_API_KEY')] },
  junie: { mode: 'one', methods: [subscription('JetBrains AI subscription')] },
  copilot: { mode: 'one', methods: [subscription('GitHub Copilot subscription')] },
  antigravity: { mode: 'one', methods: [subscription('Google account')] },
};

export function authMethods(runner: RunnerId): Capabilities {
  return capabilities[runner];
}

// A caller removes these from its inherited environment before applying env.
// Only an explicit selection comes through here. A legacy launch keeps its existing environment.
const anthropic = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE'];
const openai = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID'];
const multi = [
  ...anthropic, ...openai, 'ANTHROPIC_OAUTH_TOKEN', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'AZURE_OPENAI_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'DEEPSEEK_API_KEY',
  'XAI_API_KEY', 'PERPLEXITY_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
];

const conflicts: Record<RunnerId, string[]> = {
  claude: [...anthropic, 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX',
    'OPENROUTER_API_KEY', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'],
  codex: [...openai, 'CODEX_API_KEY', 'CODEX_PROVIDER_API_KEY', 'OPENROUTER_API_KEY', 'AZURE_OPENAI_API_KEY'],
  opencode: [...multi, 'OPENCODE_AUTH_CONTENT'],
  pi: [...multi, 'OMP_CEZAR_OAUTH_PROVIDER', 'OMP_CEZAR_OAUTH_CHECK'],
  omp: [...multi, 'OMP_CEZAR_OAUTH_PROVIDER', 'OMP_CEZAR_OAUTH_CHECK'],
  kimi: [...openai, 'KIMI_API_KEY', 'KIMI_BASE_URL', 'KIMI_MODEL_NAME', 'KIMI_MODEL_API_KEY', 'KIMI_MODEL_PROVIDER_TYPE',
    'KIMI_MODEL_BASE_URL', 'KIMI_CODE_CUSTOM_HEADERS', 'KIMI_CODE_BASE_URL', 'KIMI_OAUTH_HOST', 'KIMI_CODE_OAUTH_HOST'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY_AUTH_MECHANISM'],
  cursor: ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'],
  junie: ['JUNIE_API_KEY', 'JUNIE_ANTHROPIC_API_KEY', 'JUNIE_OPENAI_API_KEY', 'JUNIE_OPENROUTER_API_KEY',
    'JUNIE_GOOGLE_API_KEY', 'JUNIE_GROK_API_KEY', 'JUNIE_META_API_KEY', 'JUNIE_LITELLM_API_KEY',
    'JUNIE_LITELLM_URL', 'JUNIE_LLM_PROVIDER'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_BEARER_TOKEN', 'COPILOT_PROVIDER_WIRE_API'],
  antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

interface LaunchOptions {
  baseUrl?: string;
  key?: string;
  /** Gateways take the exact remote /models ID, including any slashes. */
  model?: string;
}

export interface ProviderLaunch {
  env: Record<string, string>;
  unsetEnv: string[];
  codexConfig?: Record<string, unknown>;
  model?: string;
  /** Extra global CLI arguments. Contains no keys. */
  argv?: string[];
}

function gatewayRoot(method: AuthMethod, baseUrl: string | undefined): string {
  if (method.kind === 'openrouter') return 'https://openrouter.ai/api';
  if (!baseUrl || !URL.canParse(baseUrl)) throw new Error('A custom provider needs a valid base URL');
  const url = new URL(baseUrl);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d+){3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('A custom provider needs an HTTPS base URL or loopback HTTP URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function selectedModel(model: string | undefined): string {
  if (!model?.trim() || model === 'auto') throw new Error('Select a model offered by this provider');
  return model;
}

export function providerLaunch(runner: RunnerId, methodId: string, options: LaunchOptions): ProviderLaunch {
  const caps = authMethods(runner);
  const method = caps.methods.find(({ id }) => id === methodId);
  if (!method) throw new Error(`Unsupported auth method for ${runner}: ${methodId}`);
  const { key, model } = options;
  const launch: ProviderLaunch = { env: {}, unsetEnv: [...conflicts[runner]], ...(model ? { model } : {}) };
  if (method.kind === 'subscription') {
    if (runner === 'codex') launch.codexConfig = { model_provider: 'openai', openai_base_url: 'https://chatgpt.com/backend-api/codex' };
    if (caps.mode === 'any') {
      const id = selectedModel(model);
      launch.model = id.startsWith(methodId + '/') ? id : methodId + '/' + id;
      if (runner === 'omp') {
        launch.argv = ['-e', fileURLToPath(import.meta.url)];
        launch.env = { OMP_CEZAR_OAUTH_PROVIDER: methodId, OMP_CEZAR_OAUTH_CHECK: randomUUID() };
      }
      if (runner === 'opencode') launch.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ enabled_providers: [methodId] });
    }
    return launch;
  }

  if (!key?.trim()) throw new Error(`A key is required for ${runner} ${methodId}`);
  if (method.kind === 'apiKey' && method.hostKeyEnv) {
    launch.env[method.hostKeyEnv] = key;
    if (runner === 'gemini') launch.argv = ['--ignore-env'];
    return launch;
  }

  const root = gatewayRoot(method, options.baseUrl);
  const endpoint = root + '/v1';
  switch (runner) {
    case 'claude':
      launch.env = { ANTHROPIC_BASE_URL: root, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' };
      launch.unsetEnv.push('CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR');
      break;
    case 'codex':
      launch.env.CODEX_PROVIDER_API_KEY = key;
      launch.codexConfig = {
        model_provider: 'cezar',
        'model_providers.cezar': { name: 'cezar', base_url: endpoint, env_key: 'CODEX_PROVIDER_API_KEY', wire_api: 'responses' },
      };
      break;
    case 'opencode': {
      const id = selectedModel(model);
      // OpenCode expands {file:...} and {env:...} in inline config text before parsing JSON.
      if (/[{}]/.test(id)) throw new Error('OpenCode cannot safely register this model ID');
      // Isolate saved provider/model headers, endpoint overrides and credentials in both CLI generations.
      const provider = 'cezar-' + randomUUID();
      launch.model = provider + '/' + id;
      const keyEnv = method.kind === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENCODE_PROVIDER_API_KEY';
      launch.env = {
        [keyEnv]: key,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: launch.model, enabled_providers: [provider],
          provider: { [provider]: {
            npm: '@ai-sdk/openai-compatible', name: method.label,
            options: { baseURL: endpoint, apiKey: `{env:${keyEnv}}` },
            models: { [id]: { name: id } },
          } },
        }),
      };
      break;
    }
    case 'pi':
    case 'omp': {
      const id = selectedModel(model);
      // Both CLIs prefer credentials saved for a provider over its ambient key.
      const provider = 'cezar-' + randomUUID();
      launch.model = provider + '/' + id;
      launch.env = { PI_CEZAR_GATEWAY_PROVIDER: provider, PI_CEZAR_GATEWAY_MODEL: id,
        PI_CEZAR_GATEWAY_URL: endpoint, PI_CEZAR_GATEWAY_KEY: key, PI_CEZAR_GATEWAY_RUNNER: runner };
      launch.argv = ['-e', fileURLToPath(import.meta.url)];
      break;
    }
    case 'kimi':
      launch.env = { KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_BASE_URL: endpoint, KIMI_MODEL_API_KEY: key,
        KIMI_MODEL_NAME: selectedModel(model) };
      launch.model = '__kimi_env_model__';
      break;
    default:
      throw new Error(`No gateway launch for ${runner}`);
  }
  return launch;
}

interface OAuthAccount {
  email?: string;
  accountId?: string;
  orgId?: string;
  projectId?: string;
}

interface OmpContext {
  model?: { provider: string; baseUrl: string };
  sessionManager: { getSessionId(): string };
  modelRegistry: { authStorage: {
    keys: { source(provider: string): { kind: string } | undefined };
    oauth: { accounts(provider: string): OAuthAccount[] };
    sessions: { restrict(provider: string, session: string, identities: string[]): symbol };
  } };
}

interface ExtensionApi {
  registerProvider(id: string, config: Record<string, unknown>): void;
  on?(event: 'session_start', fn: (event: unknown, context: OmpContext) => void): void;
}

// OMP's org-scoped identity format. Accounts exposes metadata without access or refresh tokens.
function ompIdentity(account: OAuthAccount): string[] {
  const email = account.email?.trim().toLowerCase();
  const base = email ? 'email:' + email : account.accountId && 'account:' + account.accountId;
  const identity = base || (account.projectId && 'project:' + account.projectId);
  const org = account.orgId ? 'org:' + account.orgId : '';
  const parts = [identity, org].filter(Boolean);
  return parts.length ? [parts.join('|')] : [];
}

/** Pi and OMP load the default export of the file passed via -e. No vendor SDK dependency. */
export default function registerGateway(api: ExtensionApi): void {
  const { OMP_CEZAR_OAUTH_PROVIDER: oauthProvider, OMP_CEZAR_OAUTH_CHECK: nonce } = process.env;
  if (oauthProvider && nonce) {
    // The OMP runner waits for this acknowledgement before sending a prompt. An API-key
    // fallback on refresh failure otherwise bypasses a successful startup OAuth probe.
    api.on?.('session_start', (_event, ctx) => {
      const auth = ctx.modelRegistry.authStorage;
      if (ctx.model?.provider !== oauthProvider || auth.keys.source(oauthProvider)?.kind !== 'oauth') return;
      const origin = new URL(ctx.model.baseUrl).origin;
      const expected = oauthProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://chatgpt.com';
      if (origin !== expected) return;
      const ids = auth.oauth.accounts(oauthProvider).flatMap(ompIdentity);
      const session = ctx.sessionManager.getSessionId();
      if (!ids.length || !session) return;
      auth.sessions.restrict(oauthProvider, session, ids);
      process.stderr.write(`cezar-omp-oauth:${nonce}\n`);
    });
    return;
  }
  const { PI_CEZAR_GATEWAY_PROVIDER: provider, PI_CEZAR_GATEWAY_URL: baseUrl, PI_CEZAR_GATEWAY_MODEL: id,
    PI_CEZAR_GATEWAY_RUNNER: runner, PI_CEZAR_GATEWAY_KEY: key } = process.env;
  if (!provider || !baseUrl || !id || !key || (runner !== 'pi' && runner !== 'omp')) {
    throw new Error('Missing per-run gateway configuration');
  }
  api.registerProvider(provider, {
    baseUrl,
    api: 'openai-completions',
    // The CLI versions use different syntax for secret references. Never treat the key itself as an expression.
    apiKey: runner === 'pi' ? '$PI_CEZAR_GATEWAY_KEY' : 'PI_CEZAR_GATEWAY_KEY',
    models: [{ id, name: id, type: 'chat', reasoning: false, input: ['text'],
      contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
