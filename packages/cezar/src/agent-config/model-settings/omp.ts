import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * omp's new-session model is `modelRoles.default` in its settings
 * (`docs/settings.md`). Precedence (low → high): built-in defaults, global
 * `~/.omp/agent/config.yml`, project `.omp/config.yml`, CLI overlays, runtime
 * overrides, setting env vars. There is no env var for the DEFAULT role (only
 * `--model` at launch and `PI_SMOL_MODEL`/`PI_SLOW_MODEL`/`PI_PLAN_MODEL` for
 * the other roles), so the file order is project then user — the catalog's
 * modelPriority 2 over 1.
 */
export const ompModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'omp',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('omp', repoRoot, env)) };
  },
};
