#!/usr/bin/env node
// Each standalone adapter compiles its own copy of the shared sources: git symlinks do not survive a
// Windows checkout (core.symlinks=false). Edit shared/, then run this; `--check` fails on any drift.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const check = process.argv.includes('--check')
let stale = []
for (const file of ['adapter-support.ts', 'pinned-request.ts']) {
  const body = `// Copied from packages/chat-plugins/shared/${file} by shared/sync.mjs. Edit the shared file.\n` + readFileSync(join(here, file), 'utf8')
  for (const plugin of ['telegram', 'slack', 'discord']) {
    const target = join(here, '..', plugin, 'src', file)
    let current
    try { current = readFileSync(target, 'utf8') } catch { current = undefined }
    if (current === body) continue
    if (check) stale.push(`${plugin}/src/${file}`)
    else writeFileSync(target, body)
  }
}
if (stale.length) {
  console.error(`Shared chat adapter sources are out of date: ${stale.join(', ')}. Run node packages/chat-plugins/shared/sync.mjs`)
  process.exit(1)
}
