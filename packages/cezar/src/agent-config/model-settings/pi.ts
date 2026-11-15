import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * pi's native-settings policy, expressed the same way every other runner's is.
 *
 * Pi stores its default model in the catalogued global/project settings files. Going through the
 * shared reader preserves the documented project-over-global precedence and safely returns no
 * native default when both files are absent or malformed.
 */
export const piModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'pi',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('pi', repoRoot, env)) };
  },
};
