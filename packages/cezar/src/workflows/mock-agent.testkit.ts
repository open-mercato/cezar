/**
 * Test-only fixture: mock the AGENT without entering `CEZ_DRY_RUN` mode.
 *
 * Why it exists (#landing-check S1): a dry run now spawns NOTHING for a
 * `command:` step — that is the point of the mode, whose README promise is an
 * offline look-around, and a check is repository code. A fixture that holds a
 * `maxParallel` slot, or ends an agent-then-check workflow terminally, through a
 * real child process therefore can no longer claim to be a dry run. What those
 * fixtures actually want is just "the agent is the bundled mock", and
 * `CEZ_CLAUDE_BIN` says exactly that: the same `scripts/mock-claude.mjs`, with
 * the check steps still running for real.
 *
 * Naming is switched off too (`CEZ_AUTONAME=0`): a dry run disabled it
 * implicitly (`autoNamingActive`), these fixtures assert on the mock's
 * argv/stdin capture files by INDEX, and a namer invocation would slide every
 * line by one. Restoring is the caller's job — the return value undoes
 * everything this function set.
 */
import { fileURLToPath } from 'node:url';

const MOCK_CLAUDE = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));

export function mockAgentWithRealChecks(): () => void {
  const saved: Record<string, string | undefined> = {
    CEZ_DRY_RUN: process.env.CEZ_DRY_RUN,
    CEZ_CLAUDE_BIN: process.env.CEZ_CLAUDE_BIN,
    CEZ_AUTONAME: process.env.CEZ_AUTONAME,
  };
  delete process.env.CEZ_DRY_RUN;
  process.env.CEZ_CLAUDE_BIN = MOCK_CLAUDE;
  process.env.CEZ_AUTONAME = '0';
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
