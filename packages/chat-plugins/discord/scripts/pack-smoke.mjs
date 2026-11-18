import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = resolve(plugin, '../../extension-sdk')
const service = resolve(plugin, '../../cezar')
const temp = mkdtempSync(join(tmpdir(), 'cezar-discord-pack-'))
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
const run = (args, cwd) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
let hadModules = false, hadLock = false
try {
  // Explicit builds make this smoke pass from clean dist/ directories.
  rmSync(join(sdk, 'dist'), { recursive: true, force: true })
  rmSync(join(plugin, 'dist'), { recursive: true, force: true })
  rmSync(join(service, 'dist'), { recursive: true, force: true })
  run(['run', 'build'], sdk)
  const sdkPack = JSON.parse(run(['pack', '--json', '--pack-destination', temp], sdk))[0]
  const modules = join(plugin, 'node_modules'), lock = join(plugin, 'package-lock.json')
  hadModules = existsSync(modules); hadLock = existsSync(lock)
  run(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, sdkPack.filename)], plugin)
  run(['run', 'build'], plugin)
  const pluginPack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], plugin))[0]
  const consumer = join(temp, 'consumer'); mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'discord-consumer', private: true, type: 'module', dependencies: {
    '@open-mercato/cezar-chat-discord': join(temp, pluginPack.filename), '@open-mercato/cezar-extension-sdk': join(temp, sdkPack.filename),
  }}))
  run(['install', '--install-strategy=nested', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  const installedPlugin = join(consumer, 'node_modules/@open-mercato/cezar-chat-discord')
  // ExtensionManager copies this directory into its immutable artifact.
  run(['install', '--prefix', installedPlugin, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, sdkPack.filename)], plugin)
  execFileSync(process.execPath, ['--input-type=module', '-e', "import x from '@open-mercato/cezar-chat-discord'; if (!x?.activate) throw new Error('extension did not load')"], { cwd: consumer, timeout: 120_000, stdio: 'inherit' })
  run(['run', 'build'], service)
  const servicePack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], service))[0]
  const cockpit = join(temp, 'cockpit'); mkdirSync(cockpit)
  writeFileSync(join(cockpit, 'package.json'), JSON.stringify({ name: 'discord-host-consumer', private: true, type: 'module' }))
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
  console.log('PASS: packed Discord plugin and packed public SDK install and run outside the workspace')
  console.log('PASS: installed Cezar tarball activates the packed Discord extension worker without credentials')
} finally {
  if (!hadModules) rmSync(join(plugin, 'node_modules'), { recursive: true, force: true })
  if (!hadLock) rmSync(join(plugin, 'package-lock.json'), { force: true })
  rmSync(temp, { recursive: true, force: true })
}
