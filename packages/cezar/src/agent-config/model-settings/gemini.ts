import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * Gemini CLI's native-settings policy (#581). Its documented precedence (bundled
 * `docs/reference/configuration.md`, 0.60.0) puts environment variables above every settings file,
 * so `GEMINI_MODEL` wins; then `model.name` from the project `.gemini/settings.json`, then the user
 * `~/.gemini/settings.json` (catalog priorities 2 and 1).
 */
export const geminiModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'gemini',
  async read(repoRoot, env) {
    if (env.GEMINI_MODEL?.trim()) return { model: env.GEMINI_MODEL.trim() };
    return { model: firstConfiguredModel(await readNativeSettingsFiles('gemini', repoRoot, env)) };
  },
};
