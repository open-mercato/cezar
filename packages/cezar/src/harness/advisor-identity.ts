export interface AdvisorIdentityRef {
  runner: string;
  model: string;
  family?: string;
}

/**
 * Ambient OpenCode auth-store credentials are safe only for the provider
 * endpoints they belong to. Keep this host-side table aligned with the
 * vendored runtime's AUTH_STORE_ENDPOINTS guard: probes run before the runtime
 * starts, so the runtime cannot enforce this boundary for them.
 */
export const TRUSTED_AUTH_STORE_PRESETS = {
  'deepseek-api': {
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/chat/completions',
  },
  'opencode-zen': {
    provider: 'opencode',
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
  },
} as const;

/**
 * Return the reason a raw advisor binding must not consume a local auth-store
 * credential. Environment credentials remain available to explicitly
 * configured OpenAI-compatible adapters; this guard protects ambient store
 * credentials, whose destination is pinned by the runtime contract.
 */
export function advisorAuthStoreBindingIssue(binding: unknown): string | null {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const model = binding as Record<string, unknown>;
  const provider = model.authStoreProvider;
  if (provider === undefined || provider === '') return null;
  if (typeof provider !== 'string') {
    return 'has an invalid local auth-store provider';
  }
  const preset = model.preset;
  const trusted =
    typeof preset === 'string'
      ? TRUSTED_AUTH_STORE_PRESETS[preset as keyof typeof TRUSTED_AUTH_STORE_PRESETS]
      : undefined;
  if (
    model.adapter !== 'preset' ||
    !trusted ||
    provider !== trusted.provider ||
    model.endpoint !== trusted.endpoint
  ) {
    return 'may use local auth only with its official preset, provider, and endpoint';
  }
  return null;
}

/**
 * Where a reviewer's environment credential may go. The repository's config names both the
 * variable and the endpoint, so without this a committed binding could send any host secret
 * (`GITHUB_TOKEN`) anywhere. Keep aligned with the vendored runtime's
 * ENV_CREDENTIAL_HOSTS guard, which enforces the same rule for council calls.
 */
export const ENV_CREDENTIAL_HOSTS: Readonly<Record<string, readonly string[]>> = {
  DEEPSEEK_API_KEY: ['api.deepseek.com'],
  OM_ZEN_KEY: ['opencode.ai'],
  OPENCODE_API_KEY: ['opencode.ai'],
  OPENAI_API_KEY: ['api.openai.com'],
  OPENROUTER_API_KEY: ['openrouter.ai'],
  GROQ_API_KEY: ['api.groq.com'],
  TOGETHER_API_KEY: ['api.together.xyz'],
  FIREWORKS_API_KEY: ['api.fireworks.ai'],
  MISTRAL_API_KEY: ['api.mistral.ai'],
  MOONSHOT_API_KEY: ['api.moonshot.ai', 'api.moonshot.cn'],
};
/** Host credentials no reviewer binding may name, whatever its endpoint. */
const HOST_SECRET_ENV =
  /^(?:GITHUB_|GH_|GITLAB_|BITBUCKET_|AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_|NPM_|NODE_AUTH_|SSH_|ANTHROPIC_|CLAUDE_|CODEX_|CEZ_|DOCKER_|HEROKU_|VERCEL_|NETLIFY_|CLOUDFLARE_|DIGITALOCEAN_|SLACK_|STRIPE_|SENTRY_)/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why a binding's environment credential must not be read for its endpoint, or null. */
export function advisorEnvCredentialIssue(binding: unknown): string | null {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const model = binding as Record<string, unknown>;
  const name = model.credentialEnv;
  if (name === undefined || name === '') return null;
  if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*_KEY$/.test(name) || HOST_SECRET_ENV.test(name)) {
    return 'may read only a provider API key (an environment variable ending in _KEY, never a host credential)';
  }
  // A command adapter hands the key to a local CLI, but an endpoint it names is pinned all the
  // same: exempting it let the readiness probe send OPENAI_API_KEY anywhere.
  if (model.endpoint === undefined && model.adapter !== 'openai-compatible') return null;
  let endpoint: URL;
  try {
    endpoint = new URL(String(model.endpoint));
  } catch {
    return 'has no valid endpoint for its environment credential';
  }
  const loopback = LOOPBACK_HOSTS.has(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    return 'may send its environment credential only over https (or to a loopback server)';
  }
  const preset = typeof model.preset === 'string'
    ? TRUSTED_AUTH_STORE_PRESETS[model.preset as keyof typeof TRUSTED_AUTH_STORE_PRESETS]
    : undefined;
  if (model.adapter === 'preset' && preset && model.endpoint !== preset.endpoint) {
    return 'may use its preset credential only with the preset\'s official endpoint';
  }
  const hosts = ENV_CREDENTIAL_HOSTS[name];
  if (hosts && !hosts.includes(endpoint.hostname)) {
    return `may send ${name} only to its provider (${hosts.join(', ')})`;
  }
  return null;
}

/** Every reason a binding must not read a local credential for its endpoint, or null. */
export function advisorCredentialBindingIssue(binding: unknown): string | null {
  return advisorAuthStoreBindingIssue(binding) ?? advisorEnvCredentialIssue(binding);
}

export type CanonicalAdvisorRef<T extends AdvisorIdentityRef> =
  T extends { runner: 'harness' } ? Omit<T, 'family'> & { family: string } : T;

export type CanonicalAdvisorResult<T extends AdvisorIdentityRef> =
  | { ok: true; refs: CanonicalAdvisorRef<T>[] }
  | { ok: false; error: string };

/**
 * Advisor family is authorization/configuration data, never a client hint.
 * Resolve it from the trusted agentHarness model table and reject a caller
 * that attempts to relabel a model to manufacture council diversity.
 */
export function canonicalizeAdvisorRefs<T extends AdvisorIdentityRef>(
  refs: readonly T[],
  models: Record<string, unknown> | undefined,
): CanonicalAdvisorResult<T> {
  const canonical: CanonicalAdvisorRef<T>[] = [];
  for (const ref of refs) {
    if (ref.runner !== 'harness') {
      canonical.push({ ...ref } as CanonicalAdvisorRef<T>);
      continue;
    }
    const raw = models?.[ref.model];
    const family =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { family?: unknown }).family
        : undefined;
    if (typeof family !== 'string' || family.trim() === '') {
      return {
        ok: false,
        error: `advisor reviewer "${ref.model}" has no trusted family in agentHarness.models`,
      };
    }
    if (ref.family !== undefined && ref.family !== family) {
      return {
        ok: false,
        error:
          `advisor reviewer "${ref.model}" was labelled as family "${ref.family}", ` +
          `but trusted configuration declares "${family}"`,
      };
    }
    const credentialIssue = advisorCredentialBindingIssue(raw);
    if (credentialIssue) {
      return {
        ok: false,
        error: `advisor reviewer "${ref.model}" ${credentialIssue}`,
      };
    }
    canonical.push({ ...ref, family } as CanonicalAdvisorRef<T>);
  }
  return { ok: true, refs: canonical };
}
