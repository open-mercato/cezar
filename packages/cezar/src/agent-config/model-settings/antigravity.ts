import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

export const antigravityModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'antigravity',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('antigravity', repoRoot, env)) };
  },
};
