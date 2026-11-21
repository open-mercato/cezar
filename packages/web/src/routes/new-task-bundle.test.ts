import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSrc(relative: string): string {
  const path = [join(process.cwd(), 'src', relative), join(process.cwd(), 'packages/web/src', relative)].find(existsSync)
  if (!path) throw new Error(`could not locate src/${relative}`)
  return readFileSync(path, 'utf8')
}
const readRoute = (relative: string): string => readSrc(join('routes', relative))

describe('New Task bundle boundary', () => {
  it('loads the opt-in harness UI through a dynamic import', () => {
    const source = readRoute('new-task.tsx')
    expect(source).toContain("import('./new-task-multi')")
    // the multi-model state and its picker helpers rode the eager bundle.
    expect(source).not.toMatch(/^import (?!type )[^\n]*from\s+['"]\.\/new-task-(harness|multi|harness-form)['"]/m)
    expect(source).not.toMatch(/^import \{[^}]*\}\s+from\s+['"]\.\/new-task-(harness|multi|harness-form)['"]/m)
  })
})

// UI performance gate: multi-model is off by default, so no eager graph pays for it.
describe('harness bundle boundaries', () => {
  it('loads the Settings harness section through a dynamic import', () => {
    const source = readRoute('settings/registry.tsx')
    expect(source).toContain("import('./harness-section')")
    expect(source).not.toMatch(/from\s+['"]\.\/harness-section['"]/)
  })

  it('loads the thread harness surface through a dynamic import', () => {
    const source = readRoute('task-thread/task-thread.tsx')
    expect(source).toContain("import('../task-harness/thread-harness')")
    expect(source).not.toMatch(/from\s+['"]\.\.\/task-harness\/(harness-components|harness-rail|harness-status-bar|reviewer-modal|thread-harness)['"]/)
  })
})

// harness schemas, hooks and picker helpers rode every cold start, flag off. These
// modules load eagerly (the composer, the shared API layer, the git toolbar every task view shows).
describe('eager modules stay harness-free', () => {
  it.each([
    'api/queries.ts',
    'api/client.ts',
    'routes/new-task.tsx',
    'routes/new-task-form.ts',
    'routes/task-git/run-git-step.tsx',
  ])('%s imports neither the harness API, its picker helpers nor its ledger state', (file) => {
    const source = readSrc(file)
    expect(source).not.toMatch(/from\s+['"](?:@\/api|\.)\/harness['"]/)
    expect(source).not.toMatch(/^import (?!type )[^\n]*from\s+['"][^'"]*new-task-harness-form['"]/m)
    expect(source).not.toMatch(/^import \{[^}]*\}\s+from\s+['"][^'"]*new-task-harness-form['"]/m)
    expect(source).not.toMatch(/from\s+['"][^'"]*task-harness\/harness-state['"]/)
    expect(source).not.toMatch(
      /\b(?:useHarnessProbe|useHarnessStatus|useCouncilDecision|useAcceptContestedHarness|useHarnessInvocation|probeHarness|defaultHarnessRoles|harnessStartBlock|HARNESS_MODES|advisorHarnessOptions)\b/,
    )
  })
})
