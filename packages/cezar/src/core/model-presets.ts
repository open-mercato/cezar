import type { RunnerId } from './agent-runner.js';

/**
 * The model-preset ids each runner's picker offers — the ids of the web composer's
 * `MODELS_BY_RUNNER` (web/app/src/routes/new-task-form.ts), hand-mirrored the same way the
 * API types are. `''` (auto) is implicit and never listed.
 *
 * This is a cross-runner GUARD, not a whitelist: models stay free-form everywhere (custom ids
 * and config presets must keep working), so the only thing ever rejected is a model that is
 * recognizably ANOTHER runner's preset — the corruption a client/server resolution mismatch
 * can produce (#401 review). Unknown ids never conflict (fail-open).
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
  opencode: [
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-5',
    'openai/gpt-5.1',
    'openai/gpt-5.1-codex',
  ],
};

/** True when `model` is recognizably a preset of a runner OTHER than `runner` (and not also
 *  one of `runner`'s own presets). `''`/unknown/custom ids never conflict. */
export function modelConflictsWithRunner(model: string, runner: RunnerId): boolean {
  if (!model) return false;
  if (KNOWN_PRESETS_BY_RUNNER[runner]?.includes(model)) return false;
  return Object.entries(KNOWN_PRESETS_BY_RUNNER).some(
    ([other, presets]) => other !== runner && presets.includes(model),
  );
}
