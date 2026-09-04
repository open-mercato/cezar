import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findProhibitedSpecifiers } from './import-boundaries.mjs'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDir = join(packageDir, 'src')
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : sourceExtensions.has(extname(entry.name)) ? [path] : []
  }))

  return files.flat()
}

const failures = []
for (const file of await walk(sourceDir)) {
  const contents = await readFile(file, 'utf8')
  for (const specifier of await findProhibitedSpecifiers(contents)) {
    failures.push(`${file}: prohibited import ${JSON.stringify(specifier)}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
