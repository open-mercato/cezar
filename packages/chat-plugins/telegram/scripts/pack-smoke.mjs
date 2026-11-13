import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = resolve(plugin, '../../extension-sdk')
const service = resolve(plugin, '../../cezar')
const temp = mkdtempSync(join(tmpdir(), 'cezar-telegram-pack-'))
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
const run = (args, cwd) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
let hadModules = false, hadLock = false
try {
  // The smoke must be independent of whatever dist artifacts a developer or a prior CI step
  // left behind. Build every published input explicitly before packing it.
  rmSync(join(sdk, 'dist'), { recursive: true, force: true })
  rmSync(join(plugin, 'dist'), { recursive: true, force: true })
  rmSync(join(service, 'dist'), { recursive: true, force: true })
  run(['run', 'build'], sdk)
  const sdkPack = JSON.parse(run(['pack', '--json', '--pack-destination', temp], sdk))[0]
  // This directory is intentionally outside the root workspace. Install the freshly packed SDK
  // just long enough for TypeScript to resolve the public imports while packing the plugin.
  const localModules = join(plugin, 'node_modules'), localLock = join(plugin, 'package-lock.json')
  hadModules = existsSync(localModules); hadLock = existsSync(localLock)
  run(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, sdkPack.filename)], plugin)
  run(['run', 'build'], plugin)
  const pluginPack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], plugin))[0]
  const consumer = join(temp, 'consumer')
  mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'telegram-consumer', private: true, type: 'module', dependencies: {
    '@open-mercato/cezar-chat-telegram': join(temp, pluginPack.filename),
    '@open-mercato/cezar-extension-sdk': join(temp, sdkPack.filename),
  }}))
  // The host copies the installed extension directory into its immutable artifact. Keep the
  // plugin's runtime dependencies inside that directory, as an installed extension artifact
  // must not rely on a sibling consumer node_modules directory after it is copied.
  run(['install', '--install-strategy=nested', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  const installedPlugin = join(consumer, 'node_modules/@open-mercato/cezar-chat-telegram')
  run(['install', '--prefix', installedPlugin, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, sdkPack.filename)])
  const check = `import { telegramRequest } from '@open-mercato/cezar-chat-telegram';
const request = telegramRequest('123456:${'A'.repeat(24)}', { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => ({ statusCode: 200, body: { async *[Symbol.asyncIterator]() { yield JSON.stringify({ ok: true, result: { id: 1 } }) }, destroy() {} }, }) });
const result = await request('getMe', {});
if (result.id !== 1) throw new Error('packed Telegram consumer failed');`
  execFileSync(process.execPath, ['--input-type=module', '-e', check], { cwd: consumer, timeout: 120_000, stdio: 'inherit' })
  // Also install the packed service: this catches accidental workspace-only imports and proves
  // the public tarballs can activate the Telegram worker through the real ExtensionHost.
  run(['run', 'build'], service)
  const servicePack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], service))[0]
  const cockpit = join(temp, 'cockpit'); mkdirSync(cockpit)
  writeFileSync(join(cockpit, 'package.json'), JSON.stringify({ name: 'telegram-host-consumer', private: true, type: 'module' }))
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', join(temp, servicePack.filename), join(temp, sdkPack.filename)], cockpit)
  const hostCheck = `import assert from 'node:assert/strict'
import { ExtensionManager } from './node_modules/@open-mercato/cezar/dist/extensions/manager.js'
const manager = new ExtensionManager(${JSON.stringify(join(temp, 'host-data'))}, 'external', ${JSON.stringify(temp)}, { home: ${JSON.stringify(join(temp, 'host-home'))} })
try {
 const record = await manager.install(${JSON.stringify(installedPlugin)})
 await manager.setEnabled(record.manifest.id, true, record.integrity)
 const installed = (await manager.list()).find(item => item.manifest.id === record.manifest.id)
 assert.equal(installed?.enabled, true)
 assert.equal(installed?.status, 'running')
} finally { await manager.close() }`
  execFileSync(process.execPath, ['--input-type=module', '-e', hostCheck], { cwd: cockpit, timeout: 120_000, stdio: 'inherit' })
  console.log('PASS: packed Telegram plugin and packed public SDK install and run outside the workspace')
  console.log('PASS: installed Cezar tarball activates the packed Telegram extension worker without credentials')
} finally {
  // Keep the source checkout clean when this smoke is run from the repository.
  if (!hadModules) rmSync(join(plugin, 'node_modules'), { recursive: true, force: true })
  if (!hadLock) rmSync(join(plugin, 'package-lock.json'), { force: true })
  rmSync(temp, { recursive: true, force: true })
}
