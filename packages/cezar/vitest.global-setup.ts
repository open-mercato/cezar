import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Shipped-adapter tests read the stamped delivery catalog; CI runs `npm test` straight after
// `npm ci`, so build it once when it is missing (spec 2026-11-09-independent-chat-plugins §5).
export default function setup(): void {
  const root = resolve(import.meta.dirname, '../..')
  if (existsSync(join(root, 'packages/cezar/dist/chat-plugins/catalog.json'))) return
  const result = spawnSync(process.execPath, [join(root, 'scripts/build-chat-plugins.mjs')], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('could not build the shipped chat adapters (npm run build:chat-plugins)')
}
