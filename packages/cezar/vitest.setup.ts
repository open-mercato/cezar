import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

// A dispatched task deliberately carries these variables so its child can report
// back to the cockpit. They are not cezar's zero-config test environment,
// though: leaving them in Vitest makes headless tests look like a connected task.
// Keep the task contract in spawned agents; isolate only this repository's tests.
for (const key of [
  'CEZ_API_URL',
  'CEZ_BIN',
  'CEZ_HANDOFF_FILE',
  'CEZ_PROJECT_ID',
  'CEZ_REMOTE',
  'CEZ_TASK_ID',
  'CEZ_TODOS_FILE',
  'CEZ_TREE_DIR',
]) delete process.env[key]

// os.tmpdir() follows TMPDIR, which a dispatched task may pin inside its
// checkout. Vitest itself must never use that path: Git commands in temporary
// repositories discover the checkout through it.
delete process.env.TMPDIR
delete process.env.TEMP
delete process.env.TMP
const testTempRoot = tmpdir()
process.env.TMPDIR = testTempRoot
process.env.TEMP = testTempRoot
process.env.TMP = testTempRoot

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
const sandboxHome = mkdtempSync(join(realpathSync(testTempRoot), 'cez-vitest-home-'))

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
