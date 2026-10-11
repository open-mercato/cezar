import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * Copilot CLI's native-settings policy.
 *
 * Copilot resolves its model from, in its own order of precedence, `--model`, the `/model`
 * command's persisted choice in `COPILOT_HOME` (default `~/.copilot`), and the `COPILOT_MODEL`
 * environment variable (`copilot help environment`, verified against 1.0.88 —
 * `.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md`). cezar owns `--model`, so what
 * this strategy reports is the default a run would get if cezar passed none: the catalogued
 * settings file first, then `COPILOT_MODEL`.
 *
 * No provider is reported. Copilot routes every model through GitHub whatever vendor answers, so
 * the provider is fixed by `BACKEND_MODEL_MAP.copilot` and is never a per-file choice.
 */
export const copilotModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'copilot',
  async read(repoRoot, env) {
    const fromFile = firstConfiguredModel(await readNativeSettingsFiles('copilot', repoRoot, env));
    if (fromFile) return { model: fromFile };
    const fromEnv = env.COPILOT_MODEL?.trim();
    return fromEnv ? { model: fromEnv } : {};
  },
};
