import type { RunnerId } from './agent-runner.ts';
import { BACKEND_MODEL_MAP, parseModelIdentity } from './model-identity.ts';

/**
 * The vendor prefixes this module treats as evidence of a mis-paired model. Deliberately local
 * rather than an export of `model-identity.ts` (#548/#831): nothing else may gate on it, because
 * `resolveModelIdentity` lets an unknown provider through on purpose. It is a heuristic for
 * {@link namesAnotherKnownProvider} alone, and being short is a feature — every entry costs a
 * false refusal if cezar is ever wrong about who serves it.
 */
const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;

/**
 * The model-preset ids each runner's picker offers — the ids of the web composer's
 * `MODELS_BY_RUNNER` (packages/web/src/routes/new-task-form.ts), hand-mirrored the same way the
 * API types are. `''` (auto) is implicit and never listed.
 *
 * This is a cross-runner GUARD, not a whitelist: models stay free-form everywhere (custom ids
 * and config presets must keep working), so the only thing ever rejected is a model that is
 * recognizably ANOTHER runner's preset — the corruption a client/server resolution mismatch
 * can produce (#401 review). Unknown ids never conflict (fail-open).
 *
 * OpenCode lists nothing here on purpose (#794): its models are discovered from the host
 * (`opencode-model-catalog.ts`), so any hard-coded list would be one release away from naming
 * models the user's provider does not have. Its half of the guard is the structural check in
 * {@link modelConflictsWithRunner} instead, which needs no vendor knowledge at all.
 */
export const KNOWN_PRESETS_BY_RUNNER: Record<RunnerId, readonly string[]> = {
  claude: [
    'opus',
    'sonnet',
    'haiku',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ],
  codex: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5-codex'],
  opencode: [],
  // pi lists nothing for the same reason OpenCode does (#794), plus one of its own: it picks a
  // model with the canonical `provider/model` convention and has no default provider, so the
  // structural check in {@link modelConflictsWithRunner} already guards it without vendor
  // knowledge. Listing pi's composer presets here would actively break OpenCode — the ids
  // overlap (`anthropic/claude-sonnet-5`), and a shared id present in pi's list but absent from
  // OpenCode's empty one would read as "another runner's preset" and be refused.
  pi: [],
};

/**
 * True when the `provider/` prefix on `model` names a provider cezar knows that this
 * single-provider runner does not serve — `anthropic/…` handed to codex.
 *
 * Deliberately narrower than the run-time gate in `model-identity.ts`: this check is
 * synchronous and therefore cannot read the runner's `configuredProvider`, so an UNFAMILIAR
 * prefix (`my-org/custom-tune`) is left alone — it may well be the user's own gateway, which
 * the run-time gate accepts once it has read the config. Only a prefix naming another known
 * vendor is evidence enough to refuse the pairing up front.
 */
function namesAnotherKnownProvider(model: string, runner: RunnerId): boolean {
  const map = BACKEND_MODEL_MAP[runner];
  // Nothing to contradict: OpenCode spans providers (no default of its own), and Claude Code
  // accepts explicit gateway/custom provider ids by design.
  if (map?.defaultProvider === undefined || map.allowExplicitProvider) return false;
  const explicit = parseModelIdentity(model);
  if (!explicit || explicit.provider === map.defaultProvider) return false;
  return (KNOWN_PROVIDERS as readonly string[]).includes(explicit.provider);
}

/** True when `model` is recognizably a preset of a runner OTHER than `runner` (and not also one
 *  of `runner`'s own presets), or when its provider prefix is one this runner is known not to
 *  serve. `''`/unknown/custom ids never conflict. */
export function modelConflictsWithRunner(model: string, runner: RunnerId): boolean {
  if (!model) return false;
  if (KNOWN_PRESETS_BY_RUNNER[runner]?.includes(model)) return false;
  // The provider half of the guard needs no vendor model knowledge, so — unlike the preset
  // lists — it keeps holding for models that do not exist yet. That is what lets OpenCode's
  // entry above be empty (#794) without losing the protection it used to provide.
  if (namesAnotherKnownProvider(model, runner)) return true;
  return Object.entries(KNOWN_PRESETS_BY_RUNNER).some(
    ([other, presets]) => other !== runner && presets.includes(model),
  );
}
