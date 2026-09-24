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
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin.
afterEach(pinSandboxHome)
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})
