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
    const authStoreIssue = advisorAuthStoreBindingIssue(raw);
    if (authStoreIssue) {
      return {
        ok: false,
        error: `advisor reviewer "${ref.model}" ${authStoreIssue}`,
      };
    }
    canonical.push({ ...ref, family } as CanonicalAdvisorRef<T>);
  }
  return { ok: true, refs: canonical };
}
