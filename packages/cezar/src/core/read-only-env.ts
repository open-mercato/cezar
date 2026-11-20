import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ghConfigDir: string | undefined;

/**
 * Defense in depth under a backend's enforced read-only mode: remove inherited gh/git auth.
 * This is not a tool fence: unrestricted tools could read credentials again, restore config,
 * or publish through MCP. A backend must enforce the policy independently of these variables.
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
    // An inherited GIT_SSH_COMMAND outranks core.sshCommand.
    GIT_SSH_COMMAND: 'false',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: 'false',
    // An empty value clears the helpers inherited from the system and user config.
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}
