import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// On Windows `--import D:\x.mjs` and `import("D:\\x.mjs")` fail with ERR_UNSUPPORTED_ESM_URL_SCHEME, so an
// absolute path must reach the ESM loader as a file:// URL. POSIX accepts both, which is why only a scan catches it.
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const roots = ['packages/cezar/src', 'packages/cezar/test', 'packages/cezar/scripts', 'packages/extension-sdk', 'packages/chat-plugins', 'scripts']

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sources(path, out)
    else if (/\.(m?[jt]s)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

// A bare specifier ('tsx'), or an expression that is visibly a URL.
const urlLike = (expr: string) => /^['"][^'"/\\:]+['"]$/.test(expr) || /pathToFileURL\(|\.href\b|(Url|URL)$/.test(expr)

export function pathImports(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/['"]--import['"]\s*,\s*([^,\]\n]+)/g)) {
    const expr = match[1]!.trim()
    if (!urlLike(expr)) found.push(`--import ${expr}`)
  }
  for (const match of text.matchAll(/(?:from |import\()\$\{JSON\.stringify\(((?:join|resolve|fileURLToPath)\()/g)) found.push(`generated import of ${match[1]}…)`)
  return found
}

describe('ESM import specifiers are file:// URLs, never filesystem paths', () => {
  it('flags the shapes that break on Windows and accepts URL forms', () => {
    expect(pathImports(`execFile(node, ['--import', tsxLoader, script])`)).toEqual(['--import tsxLoader'])
    expect(pathImports(`workerExecArgv:['--import',preload]`)).toEqual(['--import preload'])
    expect(pathImports('`import {X} from ${JSON.stringify(fileURLToPath(u))}`')).toHaveLength(1)
    expect(pathImports(`['--import', 'tsx', '--import', pathToFileURL(p).href, '--import', loaderUrl]`)).toEqual([])
  })

  it('no test, fixture or script hands the ESM loader an absolute path', () => {
    const offenders = roots.flatMap(root => sources(join(repo, root)))
      .filter(file => file !== fileURLToPath(import.meta.url))
      .flatMap(file => pathImports(readFileSync(file, 'utf8')).map(hit => `${relative(repo, file)}: ${hit}`))
    expect(offenders).toEqual([])
  })
})
