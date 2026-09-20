import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

// Nothing in this suite may write to the developer's own `~/.cezar`. Most cases pin
// `CEZ_HOME` themselves, but the pin is one global for the whole worker and their
// `afterEach` deletes it — so a write that outlives its test (a timeout is enough)
// used to resolve the real home and replace the project registry with the fixture's.
//
// This file removes the unpinned state entirely: every worker gets a sandbox home,
// and the pin is restored around every test, so a case that drops it can only leave
// the NEXT write pointed at the sandbox. A test that wants the unpinned default
// deletes the variable inside its own body (see `src/paths.test.ts`) — that still
// works, because this hook runs after the test, not during it. The write guard in
// `assertCezarHomeWriteIsSandboxed` catches whatever still slips through.
const sandboxHome = mkdtempSync(join(realpathSync(tmpdir()), 'cez-vitest-home-'))

const pinSandboxHome = (): void => {
  if (!process.env.CEZ_HOME) process.env.CEZ_HOME = sandboxHome
}

pinSandboxHome()
beforeEach(pinSandboxHome)

// Gemini CLI has no `auth status`: cezar reads its credentials from the environment and from
// `<GEMINI_CLI_HOME or ~>/.gemini/.env` (`src/core/gemini-credentials.ts`). Pin that home to the
// sandbox and drop the host's Gemini credentials, so no case depends on whether the developer
// running the suite has a Gemini key. A test that wants one sets it in its own body. The one
// exception is the opt-in real-CLI smoke (`GEMINI_REAL_SMOKE=1`, `gemini-acp-runner.smoke.test.ts`),
// which needs the real CLI to find the operator's own credentials.
if (process.env.GEMINI_REAL_SMOKE !== '1') {
  process.env.GEMINI_CLI_HOME = sandboxHome
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI']) {
    delete process.env[name]
  }
}
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin.
afterEach(pinSandboxHome)
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})
