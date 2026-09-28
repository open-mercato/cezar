import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourcePath = [
  join(process.cwd(), 'src/routes/new-task.tsx'),
  join(process.cwd(), 'packages/web/src/routes/new-task.tsx'),
].find(existsSync)

if (!sourcePath) throw new Error('could not locate routes/new-task.tsx')
const source = readFileSync(sourcePath, 'utf8')

describe('New Task bundle boundary', () => {
  it('loads the opt-in harness UI through a dynamic import', () => {
    expect(source).toContain("import('./new-task-harness')")
    expect(source).not.toMatch(/from\s+['"]\.\/new-task-harness['"]/)
  })
})
