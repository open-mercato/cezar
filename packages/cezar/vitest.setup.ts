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
// Fixture repos commit constantly; a developer's global `commit.gpgsign=true` turns each
// commit into a gpg round-trip (~0.35s) and pushes git-heavy cases past the 5s timeout
// under parallel load. Signing is irrelevant to every fixture, so switch it off here —
// injected through git's env config, so no global or repo config file is touched.
if (!process.env.GIT_CONFIG_COUNT) {
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
  process.env.GIT_CONFIG_VALUE_0 = 'false'
}

// LLM task naming is on by default (`autoNamingActive`), so any case that starts a run on
// a real backend spawned `claude -p "[cez-namer] Name this task."` on the developer's own
// subscription — the same canned tasks, every run. Off for the whole suite; a test that
// exercises the namer sets `CEZ_AUTONAME=1` itself (against mock-claude). Forced at load so
// a shell's own value cannot leak in, and re-pinned around every case like `CEZ_HOME`, so a
// case that deletes it cannot hand the next case the default-on namer.
process.env.CEZ_AUTONAME = '0'

const pinAutonameOff = (): void => {
  if (process.env.CEZ_AUTONAME === undefined) process.env.CEZ_AUTONAME = '0'
}

beforeEach(pinAutonameOff)
afterEach(pinAutonameOff)

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
