import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ghConfigDir: string | undefined;

/**
 * The floor under every backend's own read-only mode (`AgentRunSpec.readOnly`): whatever the agent
 * runs, it has no way to publish. No `gh` login and no git credential, so no push and no pull
 * request. Public fetches over https keep working.
 */
export function readOnlyEnv(): Record<string, string> {
  ghConfigDir ??= mkdtempSync(join(tmpdir(), 'cez-read-only-gh-'));
  return {
    GH_CONFIG_DIR: ghConfigDir,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '',
    GITHUB_ENTERPRISE_TOKEN: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: 'false',
    // An empty value clears the helpers inherited from the system and user config.
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}
