import {
  firstConfiguredModel,
  firstConfiguredProvider,
  readNativeSettingsFiles,
} from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

export const codexModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'codex',
  async read(repoRoot, env) {
    const files = await readNativeSettingsFiles('codex', repoRoot, env);
    const provider = firstConfiguredProvider(files);
    const model = firstConfiguredModel(files);
    return {
      ...(model
        ? { model: provider && provider !== 'openai' && !model.includes('/') ? `${provider}/${model}` : model }
        : {}),
      ...(provider ? { provider } : {}),
    };
  },
};
