import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run trusted fixture commands through the real validation runner without depending on
 * host sandbox tools. The isolation test uses the production launcher. */
export function createTestValidationLauncher() {
  const root = mkdtempSync(join(tmpdir(), 'cez-gate-unit-'));
  const gh = join(root, 'gh');
  mkdirSync(gh);
  return {
    env: { GH_CONFIG_DIR: gh, TMPDIR: root },
    command: (args: string[]) => ({ executable: 'bash', args }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
