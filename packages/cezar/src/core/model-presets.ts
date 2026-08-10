import type { RunnerId } from './agent-runner.ts';

/**
 * The model-preset ids each runner's picker offers — the ids of the web composer's
 * `MODELS_BY_RUNNER` (packages/web/src/routes/new-task-form.ts), hand-mirrored the same way the
 * API types are. `''` (auto) is implicit and never listed.
 *
 * This is a cross-runner GUARD, not a whitelist: models stay free-form everywhere (custom ids
 * and config presets must keep working), so the only thing ever rejected is a model that is
 * recognizably ANOTHER runner's preset — the corruption a client/server resolution mismatch
 * can produce (#401 review). Unknown ids never conflict (fail-open).
 */
export const KNOWN_PRESETS_BY_RUNNER: Record<RunnerId, readonly string[]> = {
  // Tier aliases only. The dated ids that used to sit here (`claude-opus-4-8` and friends) came
  // off the picker when Claude gained host discovery (#784) — a guard that names a specific
  // vendor release goes stale the same way the picker did, and this list mirrors the picker.
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5-codex'],
  opencode: [
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-5',
    'openai/gpt-5.1',
    'openai/gpt-5.1-codex',
  ],
};

/**
 * Bare id shapes that name a backend's OWN vendor — mirrored from the web's
 * `NATIVE_MODEL_ID_PREFIX`. Structural rather than dated so the guard survives the preset lists
 * dropping vendor releases (#784): every `claude-*` id is Anthropic's, including the ones that do
 * not exist yet. A gateway id names its provider explicitly (`anthropic/claude-…`) and is left
 * alone — some backends legitimately accept one.
 */
const NATIVE_MODEL_ID_PREFIX: Partial<Record<RunnerId, RegExp>> = {
  claude: /^claude[-.]/,
  codex: /^gpt[-.]/,
};

/** True when `model` is recognizably another runner's — its preset, or its vendor's bare id shape
 *  — and not also one of `runner`'s own. `''`/unknown/custom ids never conflict. */
export function modelConflictsWithRunner(model: string, runner: RunnerId): boolean {
  if (!model) return false;
  if (KNOWN_PRESETS_BY_RUNNER[runner]?.includes(model)) return false;
  if (NATIVE_MODEL_ID_PREFIX[runner]?.test(model)) return false;
  return (
    Object.entries(KNOWN_PRESETS_BY_RUNNER).some(
      ([other, presets]) => other !== runner && presets.includes(model),
    ) ||
    Object.entries(NATIVE_MODEL_ID_PREFIX).some(
      ([other, prefix]) => other !== runner && prefix.test(model),
    )
  );
}
