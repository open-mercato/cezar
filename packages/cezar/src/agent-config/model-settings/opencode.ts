import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

export const opencodeModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'opencode',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('opencode', repoRoot, env)) };
  },
};
