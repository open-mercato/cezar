import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const repo = join(import.meta.dirname, '../../../..')
const dir = join(repo, 'packages/web/e2e')
const runnerSpecs = readdirSync(dir).filter(name => name.endsWith('.e2e.ts') && readFileSync(join(dir, name), 'utf8').includes("from '@e2e-dev/web'"))
const configs = readdirSync(dir).filter(name => name.endsWith('.config.ts') && name !== 'vitest.config.ts')

it('reaches every @e2e-dev/web spec through a config that npm run test:e2e:runner discovers', () => {
  expect(runnerSpecs.length).toBeGreaterThan(0)
  // A literal `tests:` path, or the shared Slack/Discord factory (e2e/chat-fixture.ts) naming its suite.
  const reached = new Set(configs.flatMap(name => {
    const source = readFileSync(join(dir, name), 'utf8')
    return [...[...source.matchAll(/tests:\s*'\.\/([^']+)'/g)].map(m => m[1]), ...[...source.matchAll(/chatFixtureConfig\('([^']+)'/g)].map(m => `chat-${m[1]}.e2e.ts`)]
  }))
  expect(runnerSpecs.filter(name => !reached.has(name))).toEqual([])

  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  expect(pkg.scripts['test:e2e:runner']).toBe('sh .ai/scripts/e2e-runner.sh')
  // Discovery by glob, so a new config cannot be left out of the script.
  expect(readFileSync(join(repo, '.ai/scripts/e2e-runner.sh'), 'utf8')).toContain('"$E2E_DIR"/*.config.ts')
})
