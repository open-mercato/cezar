import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * pi's native-settings policy, expressed the same way every other runner's is.
 *
 * Nothing in the agent-config catalog (`catalog.ts`) names a pi-owned settings file yet, so
 * `readNativeSettingsFiles` finds none and this reports "no native default" — which is the
 * truthful answer, not a stub: the cockpit then falls back to cezar's own preset for pi exactly
 * as it does for a runner whose config file the user has never written. Going through the shared
 * reader rather than returning `{}` outright means the day a pi config file IS catalogued, this
 * strategy starts honoring it with no change here.
 */
export const piModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'pi',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('pi', repoRoot, env)) };
  },
};
