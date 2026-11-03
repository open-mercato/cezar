import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * Kimi Code's native default: `default_model` in `~/.kimi-code/config.toml`. The value is already
 * the alias Kimi selects with (`kimi-code/k3`), which is also the id cezar hands it, so it passes
 * through unchanged.
 */
export const kimiModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'kimi',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('kimi', repoRoot, env)) };
  },
};
