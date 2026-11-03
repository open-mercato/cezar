import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * junie's native-settings policy, expressed the same way every other runner's
 * is. Nothing in the agent-config catalog (`catalog.ts`) names a junie-owned
 * settings file yet (`~/.junie/config.json` / `<project>/.junie/config.json`
 * both carry a `model` key, confirmed live), so `readNativeSettingsFiles`
 * finds none and this reports "no native default" — the truthful answer, not
 * a stub: the cockpit falls back to cezar's own preset exactly as it does for
 * pi today. The day junie's config file is catalogued, this strategy starts
 * honoring it with no change here.
 */
export const junieModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'junie',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('junie', repoRoot, env)) };
  },
};
