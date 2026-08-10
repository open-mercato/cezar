/**
 * Canonical provider/model identity (#405). One backend-agnostic shape that
 * every runner shares, so a persisted run records WHICH provider + model
 * actually served it — the identity that cost accounting, session attribution
 * and reproducible replay all key off (see the issue's claim table).
 *
 * Backends name models differently on the wire: `claude` takes bare tier
 * aliases / pinned ids on `--model` (`opus`, `claude-opus-4-8`); `codex` takes
 * `gpt-*-codex` ids verbatim; `opencode` takes a `provider/model` string it
 * re-splits into `{ providerID, modelID }`. This module maps each of those to
 * and from ONE canonical `{ provider, model }`, and is the single
 * parser/normaliser they all use — extracted from opencode's private
 * `parseModel` (#405 item 2) so no runner invents a second one.
 *
 * Extensible by design: a new backend (#387's `pi` runner) adds one entry to
 * `BACKEND_MODEL_MAP` and, if it needs a non-default wire form, one branch in
 * `toBackendModel`. Nothing else changes.
 *
 * Deliberately imports no backend-specific wire type: the canonical identity
 * never leaks a runner's request shape past the `AgentRunner` seam.
 */
import type { AgentBackend } from './agent-runner.ts';

/**
 * A backend-agnostic model identity. Serialized as `provider/model` (see
 * {@link formatModelIdentity}). Treated as an identifier, never display text.
 */
export interface ModelIdentity {
  /** Canonical provider id, lowercased — e.g. `anthropic`, `openai`. */
  provider: string;
  /** Provider-native model id — e.g. `claude-opus-4-8`, `gpt-5.1-codex`. */
  model: string;
}

/**
 * Thrown when a non-empty model string cannot be resolved to a canonical
 * identity for the chosen backend (a bare id on a backend that spans
 * providers). Fail-loud (#405 item 3): the run surfaces this instead of
 * silently substituting the backend default.
 */
export class ModelIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelIdentityError';
  }
}

/**
 * No provider allowlist lives here on purpose (#548). `resolveModelIdentity`
 * lets an unknown provider in an explicit `provider/model` string pass through,
 * so future models and new backends are never silently rejected — an exported
 * roster of "providers cezar names today" would gate nothing, and an unused
 * public export reads as a contract someone must keep current. The per-backend
 * knowledge that IS load-bearing lives in `BACKEND_MODEL_MAP` below.
 */

interface BackendModelMap {
  /**
   * The provider a bare (provider-less) model id belongs to for this backend.
   * `undefined` marks a backend that spans providers and therefore requires an
   * explicit `provider/model` — a bare id there is ambiguous and rejected.
   * It also selects the wire form in {@link toBackendModel}.
   */
  readonly defaultProvider?: string;
  /** Whether explicit foreign provider/model ids are valid backend-native ids. */
  readonly allowExplicitProvider?: boolean;
  /** Whether the backend wire model keeps the explicit provider prefix. */
  readonly wireProviderQualified?: boolean;
  /**
   * Bare model id → provider override, for the rare backend whose bare ids
   * span providers. Checked before `defaultProvider`; empty for today's set.
   */
  readonly providerByModel?: Readonly<Record<string, string>>;
}

/**
 * Per-backend mapping table — the one place #387 extends for the `pi` runner.
 * `claude-cli` is the legacy id kept so old run records normalise identically
 * to `claude`. That is now true end to end: `storedRunnerSchema`
 * (`runs/store.ts`) parses the legacy spelling out of `runs.json` and folds it
 * to `claude` (#547), so the entry below is what a record carrying it maps
 * through on the way in — not, as the comment used to imply, a mapping for a
 * value the store could never load.
 */
export const BACKEND_MODEL_MAP: Readonly<Record<AgentBackend, BackendModelMap>> = {
  // Claude Code supports custom/gateway model ids such as DeepSeek via an
  // Anthropic-compatible endpoint, so preserve an explicit provider/model.
  claude: { defaultProvider: 'anthropic', allowExplicitProvider: true, wireProviderQualified: true },
  'claude-cli': { defaultProvider: 'anthropic', allowExplicitProvider: true, wireProviderQualified: true },
  // Codex selects the provider from model_provider in config.toml. A foreign
  // explicit prefix is accepted only when the caller proves it matches that
  // effective setting; the provider is then stripped from the wire model id.
  codex: { defaultProvider: 'openai' },
  // opencode selects across providers, so a bare model is ambiguous: reject it
  // loudly rather than let the server pick a default the user never asked for.
  opencode: {},
  // pi selects across providers with the same `provider/model` convention as
  // opencode (#387) — no default provider, so a bare model is rejected loudly
  // and `toBackendModel` hands pi the full `provider/model` on its `--model`.
  pi: {},
};

const SLASH = '/';

/** Serialize a canonical identity to its `provider/model` string form. */
export function formatModelIdentity(id: ModelIdentity): string {
  return `${id.provider}${SLASH}${id.model}`;
}

/**
 * Parse a `provider/model` string into a canonical identity. Returns `null`
 * for anything not in explicit provider/model form (empty, bare, a leading or
 * trailing slash). The single shared parser every runner splits with —
 * extracted from opencode's private `parseModel` (#405 item 2).
 */
export function parseModelIdentity(raw: string | undefined | null): ModelIdentity | null {
  if (!raw) return null;
  const s = raw.trim();
  const idx = s.indexOf(SLASH);
  // idx <= 0 rejects "" and "/model"; idx at the end rejects "provider/".
  if (idx <= 0 || idx >= s.length - 1) return null;
  return { provider: s.slice(0, idx).toLowerCase(), model: s.slice(idx + 1).trim() };
}

/**
 * Resolve a raw model string — a preset id (`opus`, `gpt-5.1-codex`) or an
 * explicit `provider/model` — as supplied for `backend`, into a canonical
 * identity. Fail-loud (#405 item 3): a real model is never silently swapped
 * for the backend default.
 *  - empty / whitespace ("auto") → `undefined` (the backend picks — an
 *    explicit choice, not a silent fallback);
 *  - an explicit `provider/model` → that identity, for a multi-provider backend
 *    or when the provider is the single-provider backend's own;
 *  - an explicit `provider/model` naming a FOREIGN provider is preserved when
 *    the backend supports custom/gateway model ids;
 *  - a bare id → the backend's default provider;
 *  - a bare id on a backend with no default provider → throws
 *    {@link ModelIdentityError}.
 */
export function resolveModelIdentity(
  backend: AgentBackend,
  raw: string | undefined,
  options: { configuredProvider?: string } = {},
): ModelIdentity | undefined {
  if (!raw || !raw.trim()) return undefined;
  const map = BACKEND_MODEL_MAP[backend] ?? {};
  const configuredProvider = options.configuredProvider?.trim().toLowerCase() || undefined;
  const effectiveProvider = configuredProvider ?? map.defaultProvider;
  const explicit = parseModelIdentity(raw);
  if (explicit) {
    // Most single-provider backends need their bare wire form, but Claude Code
    // also accepts explicit gateway/custom provider ids. Keep rejecting foreign
    // providers for backends that do not advertise that capability.
    if (
      map.defaultProvider !== undefined &&
      explicit.provider !== effectiveProvider &&
      !map.allowExplicitProvider
    ) {
      throw new ModelIdentityError(
        configuredProvider
          ? `provider "${explicit.provider}" doesn't match the ${backend} runner's configured provider "${configuredProvider}" — use "${configuredProvider}/${explicit.model}" or a bare model id`
          : `provider "${explicit.provider}" can't be verified for the ${backend} runner (serves ${map.defaultProvider}) — use "${map.defaultProvider}/${explicit.model}" or a bare model id`,
      );
    }
    return explicit;
  }
  const model = raw.trim();
  const provider = map.providerByModel?.[model] ?? effectiveProvider;
  if (!provider) {
    throw new ModelIdentityError(
      `model "${model}" is ambiguous for the ${backend} runner — name the provider as "provider/model" (e.g. anthropic/${model})`,
    );
  }
  return { provider, model };
}

/**
 * The model string to hand `backend`'s CLI/API for a canonical identity — the
 * inverse of {@link resolveModelIdentity}. Single-provider backends
 * (claude/codex) want the bare provider-native id (`opus`, `gpt-5.1-codex`);
 * multi-provider backends (opencode) want the full `provider/model`, which
 * they re-split into their own request shape.
 */
export function toBackendModel(backend: AgentBackend, id: ModelIdentity): string {
  const map = BACKEND_MODEL_MAP[backend] ?? {};
  if (map.defaultProvider === undefined) return formatModelIdentity(id);
  if (
    map.allowExplicitProvider &&
    map.wireProviderQualified &&
    id.provider !== map.defaultProvider
  ) {
    return formatModelIdentity(id);
  }
  return id.model;
}

/**
 * Normalise a raw model string for `backend` in one step: the backend-native
 * string to hand the runner, plus the canonical identity to persist. Returns
 * `undefined` for empty/auto. Throws {@link ModelIdentityError} on an
 * unresolvable model — the single fail-loud gate the run wiring calls.
 */
export function normalizeModelForBackend(
  backend: AgentBackend,
  raw: string | undefined,
  options: { configuredProvider?: string } = {},
): { backendModel: string; identity: ModelIdentity } | undefined {
  const identity = resolveModelIdentity(backend, raw, options);
  if (!identity) return undefined;
  return { backendModel: toBackendModel(backend, identity), identity };
}
