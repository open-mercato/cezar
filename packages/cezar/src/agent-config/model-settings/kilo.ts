import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

export const kiloModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'kilo',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('kilo', repoRoot, env)) };
  },
};
