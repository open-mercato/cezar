import routes from './routes.tsx?raw'
import { expect, it } from 'vitest'

it('keeps dashboard widgets and report generation out of the initial route import graph', () => {
  expect(routes).not.toMatch(/import\s+[^\n]+\s+from\s+['"][^'"]*routes\/dashboard['"]/)
  expect(routes).toMatch(/import\(['"]\.\/routes\/dashboard['"]\)/)
})
