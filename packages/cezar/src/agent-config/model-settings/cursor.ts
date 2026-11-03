import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * Cursor Agent CLI keeps the selected model in `~/.cursor/cli-config.json`
 * (`model.displayModelId` / `model.modelId`). Project `.cursor/cli.json` is
 * permissions-only and is not a model source.
 */
export const cursorModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'cursor',
  async read(repoRoot, env) {
    const model = firstConfiguredModel(await readNativeSettingsFiles('cursor', repoRoot, env));
    // Cursor stores "Auto" as the literal string `auto`, which means "no --model flag" — the
    // same sentinel cursor-model-catalog.ts filters out of the picker list.
    return { model: model === 'auto' ? undefined : model };
  },
};
