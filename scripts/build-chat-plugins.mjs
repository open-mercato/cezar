#!/usr/bin/env node
// Build standalone chat packages before release scripts publish with --ignore-scripts.
// They are intentionally not workspaces: each package must be usable from its own tarball.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const sdk = spawnSync(npm, ['run', 'build', '-w', '@open-mercato/cezar-extension-sdk'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (sdk.error) throw sdk.error
if (sdk.status !== 0) process.exit(sdk.status ?? 1)
for (const plugin of ['telegram', 'slack', 'discord']) {
  const result = spawnSync(npm, ['run', 'build'], {
    cwd: join(root, 'packages', 'chat-plugins', plugin),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const delivery = spawnSync(process.execPath, [join(root, 'packages/cezar/scripts/build-chat-delivery.mjs')], {cwd:root,stdio:'inherit'})
if (delivery.error) throw delivery.error
if (delivery.status !== 0) process.exit(delivery.status ?? 1)
