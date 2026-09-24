import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

export const claudeModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'claude',
  async read(repoRoot, env) {
    // Claude Code gives ANTHROPIC_MODEL higher priority than settings files.
    if (env.ANTHROPIC_MODEL?.trim()) return { model: env.ANTHROPIC_MODEL.trim() };
    return { model: firstConfiguredModel(await readNativeSettingsFiles('claude', repoRoot, env)) };
  },
};
