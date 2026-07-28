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
 * Providers cezar names today. Informational and extensible — an unknown
 * provider in an explicit `provider/model` string still passes through, so
 * future models and new backends are never silently rejected.
 */
export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

interface BackendModelMap {
  /**
   * The provider a bare (provider-less) model id belongs to for this backend.
   * `undefined` marks a backend that spans providers and therefore requires an
   * explicit `provider/model` — a bare id there is ambiguous and rejected.
   * It also selects the wire form in {@link toBackendModel}.
   */
  readonly defaultProvider?: string;
  /**
   * Bare model id → provider override, for the rare backend whose bare ids
   * span providers. Checked before `defaultProvider`; empty for today's set.
   */
  readonly providerByModel?: Readonly<Record<string, string>>;
}

/**
 * Per-backend mapping table — the one place #387 extends for the `pi` runner.
 * `claude-cli` is the legacy id kept so old run records normalise identically
 * to `claude`.
 */
export const BACKEND_MODEL_MAP: Readonly<Record<AgentBackend, BackendModelMap>> = {
  claude: { defaultProvider: 'anthropic' },
  'claude-cli': { defaultProvider: 'anthropic' },
  codex: { defaultProvider: 'openai' },
  // opencode selects across providers, so a bare model is ambiguous: reject it
  // loudly rather than let the server pick a default the user never asked for.
  opencode: {},
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
 *  - an explicit `provider/model` naming a FOREIGN provider on a single-provider
 *    backend → throws {@link ModelIdentityError} (it would be dropped on the wire
 *    yet persisted, asserting a provider that never ran — #405 review M2);
 *  - a bare id → the backend's default provider;
 *  - a bare id on a backend with no default provider → throws
 *    {@link ModelIdentityError}.
 */
export function resolveModelIdentity(
  backend: AgentBackend,
  raw: string | undefined,
): ModelIdentity | undefined {
  if (!raw || !raw.trim()) return undefined;
  const map = BACKEND_MODEL_MAP[backend] ?? {};
  const explicit = parseModelIdentity(raw);
  if (explicit) {
    // A single-provider backend (claude/codex) can only serve its own provider. An explicit
    // foreign provider would be silently dropped on the wire — `toBackendModel` hands the CLI
    // the bare model id — while the record persists the foreign provider, asserting one that
    // never served the run (#405 review M2). Reject it, the same fail-loud contract a bare id
    // gets on a multi-provider backend.
    if (map.defaultProvider !== undefined && explicit.provider !== map.defaultProvider) {
      throw new ModelIdentityError(
        `provider "${explicit.provider}" can't be served by the ${backend} runner (serves ${map.defaultProvider}) — use "${map.defaultProvider}/${explicit.model}" or a bare model id`,
      );
    }
    return explicit;
  }
  const model = raw.trim();
  const provider = map.providerByModel?.[model] ?? map.defaultProvider;
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
  return map.defaultProvider === undefined ? formatModelIdentity(id) : id.model;
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
): { backendModel: string; identity: ModelIdentity } | undefined {
  const identity = resolveModelIdentity(backend, raw);
  if (!identity) return undefined;
  return { backendModel: toBackendModel(backend, identity), identity };
}
