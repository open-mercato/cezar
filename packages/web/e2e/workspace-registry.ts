import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { readTestEnv } from './agent-browser'

/**
 * The shared test env's workspace registry — and the run-wide pin that keeps its SHAPE
 * deterministic.
 *
 * Since the multi-project spec's Step 3.3 the cockpit renders the grouped multi-project sidebar
 * whenever the registry holds MORE THAN ONE project, and the flat one otherwise. The shared env
 * boots with `CEZ_HOME=.ai/qa/cez-home` (`.ai/scripts/test-env-up.sh`), which is a gitignored,
 * mutable scratch home: whatever the operator last registered there decides which of the two
 * shells the specs meet. That is not a property any spec should inherit by accident — a QA
 * session that registered three projects to capture sidebar screenshots turned `smoke.e2e.ts`
 * into five selector failures that looked exactly like product breakage.
 *
 * So the run pins it: `setup()` below (wired as vitest `globalSetup`) trims the registry to the
 * boot project alone before any spec opens a page, and puts it back verbatim afterwards. Specs
 * that assert the flat shell then get the flat shell, always. A spec that wants the OTHER shape
 * asks for it explicitly — `project-groups.e2e.ts` seeds its own multi-project registry through
 * `snapshotSharedHome` + `writeSharedProjects` and restores it in `afterAll`.
 *
 * `fixtureServeEnv` (agent-browser.ts) is this rule for the specs that boot their own server.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
/** Mirrors `CEZ_HOME` in `.ai/scripts/test-env-up.sh` — change one, change the other. */
const sharedHome = resolve(repoRoot, '.ai/qa/cez-home')

/** One registry entry, as `~/.cezar/config.json` stores it (src/workspace/config.ts). */
export type RegistryProject = {
  id: string
  root: string
  name?: string
  addedAt?: string
  lastOpenedAt?: string
  source?: 'local' | 'checkout'
}

type SharedConfig = { projects?: RegistryProject[] } & Record<string, unknown>

/**
 * A path inside the pinned test home.
 *
 * The guard is the point: everything in this module REWRITES workspace state, and the one file
 * it must never reach is the operator's real `~/.cezar/` — losing that means losing their whole
 * project list. `.ai/qa/cez-home` can only collide with it if the repo itself lives at `$HOME`,
 * so that is exactly what is refused.
 */
function sharedFile(name: string): string {
  const path = resolve(sharedHome, name)
  if (path.startsWith(resolve(homedir(), '.cezar'))) {
    throw new Error(`cezar e2e: refusing to touch the real workspace home at ${path}`)
  }
  return path
}

function readSharedConfig(): SharedConfig {
  const path = sharedFile('config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SharedConfig
  } catch {
    // A corrupt scratch config is the app's problem to degrade over, not this module's.
    return {}
  }
}

/** The registry as it currently stands, entries in stored order. */
export function readSharedProjects(): RegistryProject[] {
  return readSharedConfig().projects ?? []
}

/**
 * Replace the registry's `projects` array, leaving every other key (schemaVersion, projectsDir,
 * resources) untouched. `GET /api/v1/projects` reads the file per request, so the next page load
 * sees this — no server restart.
 */
export function writeSharedProjects(projects: RegistryProject[]): void {
  const config = readSharedConfig()
  // mode 0600 to match what the app writes (src/workspace/config.ts) — it only applies when the
  // file is created, which is the one case where the default would be wrong.
  writeFileSync(sharedFile('config.json'), `${JSON.stringify({ ...config, projects }, null, 2)}\n`, {
    mode: 0o600,
  })
}

/**
 * Snapshot the named files under the pinned test home and hand back the restore.
 *
 * Byte-for-byte, including "did not exist" — a spec that seeds a registry must not leave the
 * operator's scratch home holding its fake projects, and one that toggles a sidebar group must
 * not leave its collapse state in `ui-state.json`.
 */
export function snapshotSharedHome(...names: string[]): () => void {
  const before = names.map((name) => {
    const path = sharedFile(name)
    return { path, content: existsSync(path) ? readFileSync(path, 'utf8') : null }
  })
  return () => {
    for (const { path, content } of before) {
      if (content === null) rmSync(path, { force: true })
      else writeFileSync(path, content, { mode: 0o600 })
    }
  }
}

/**
 * vitest `globalSetup` — pin the registry to the single-project shape for the whole run.
 *
 * "The boot project alone" rather than "empty": the flat shell is what a real single-project
 * workspace renders, and dropping the boot entry too would also drop the `lastOpenedAt` the
 * cockpit orders by. Filtering by the id the SERVER reports keeps this honest — the slug is
 * allocated by the registry, so only the server knows it.
 *
 * Degrades silently when the env is not up: the specs' own `readTestEnv()` produces the useful
 * error, and a globalSetup that threw first would hide it.
 */
export async function setup(): Promise<() => void> {
  let bootProject: string
  try {
    const { baseUrl } = readTestEnv()
    const body = (await (await fetch(`${baseUrl}/api/v1/projects`)).json()) as { bootProject: string }
    bootProject = body.bootProject
  } catch {
    return () => {}
  }
  const restore = snapshotSharedHome('config.json')
  writeSharedProjects(readSharedProjects().filter((project) => project.id === bootProject))
  return restore
}
