import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDir = join(packageDir, 'src')
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const importPatterns = [
  /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:[\w*${},\s]+?\s+from\s+)?["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
]

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : sourceExtensions.has(extname(entry.name)) ? [path] : []
  }))

  return files.flat()
}

const violatesBoundary = (specifier) =>
  /(?:^|\/)packages\/web(?:\/|$)/.test(specifier)
  || specifier === '@'
  || specifier.startsWith('@/')
  || specifier === '@open-mercato/cezar-contract'
  || specifier.startsWith('@open-mercato/cezar-contract/')
  || specifier === '@open-mercato/cezar-react/src'
  || specifier.startsWith('@open-mercato/cezar-react/src/')
  || specifier.startsWith('node:')

const failures = []
for (const file of await walk(sourceDir)) {
  const contents = await readFile(file, 'utf8')
  for (const pattern of importPatterns) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier && violatesBoundary(specifier)) {
        failures.push(`${file}: prohibited import ${JSON.stringify(specifier)}`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
