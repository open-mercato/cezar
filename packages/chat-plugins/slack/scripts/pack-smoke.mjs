import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = resolve(plugin, '../../extension-sdk')
const service = resolve(plugin, '../../cezar')
const temp = mkdtempSync(join(tmpdir(), 'cezar-slack-pack-'))
const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
const run = (args, cwd) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
let hadModules = false, hadLock = false
try {
  run(['run', 'build'], sdk)
  const sdkPack = JSON.parse(run(['pack', '--json', '--pack-destination', temp], sdk))[0]
  const modules = join(plugin, 'node_modules'), lock = join(plugin, 'package-lock.json'); hadModules = existsSync(modules); hadLock = existsSync(lock)
  run(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, sdkPack.filename)], plugin)
  run(['run', 'build'], plugin)
  const pluginPack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], plugin))[0]
  const consumer = join(temp, 'consumer'); mkdirSync(consumer); writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'slack-consumer', private: true, type: 'module', dependencies: { '@open-mercato/cezar-chat-slack': join(temp, pluginPack.filename), '@open-mercato/cezar-extension-sdk': join(temp, sdkPack.filename) } }))
  run(['install', '--install-strategy=nested', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  const installed = join(consumer, 'node_modules/@open-mercato/cezar-chat-slack')
  run(['install', '--prefix', installed, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, sdkPack.filename)], plugin)
  execFileSync(process.execPath, ['--input-type=module', '-e', "import x from '@open-mercato/cezar-chat-slack'; if (!x?.activate) throw new Error('extension did not load')"], { cwd: consumer, timeout: 120_000, stdio: 'inherit' })
  // The installed-host smoke needs the service's compiled entrypoints, not only its manifest.
  run(['run', 'build'], service)
  const servicePack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], service))[0]
  const cockpit = join(temp, 'cockpit'); mkdirSync(cockpit); writeFileSync(join(cockpit, 'package.json'), JSON.stringify({ name: 'slack-host-consumer', private: true, type: 'module' }))
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', join(temp, servicePack.filename), join(temp, sdkPack.filename)], cockpit)
  const check = `import assert from 'node:assert/strict'; import { ExtensionManager } from './node_modules/@open-mercato/cezar/dist/extensions/manager.js'; const m = new ExtensionManager(${JSON.stringify(join(temp, 'data'))}, 'external', ${JSON.stringify(temp)}, { home: ${JSON.stringify(join(temp, 'home'))} }); const r = await m.install(${JSON.stringify(installed)}); await m.setEnabled(r.manifest.id, true, r.integrity); assert.equal((await m.list()).find(x => x.manifest.id === r.manifest.id)?.status, 'running'); await m.close()`
  execFileSync(process.execPath, ['--input-type=module', '-e', check], { cwd: cockpit, timeout: 120_000, stdio: 'inherit' })
  console.log('PASS: packed Slack plugin and SDK load outside workspace')
  console.log('PASS: installed Cezar tarball activates packed Slack extension')
} finally { if (!hadModules) rmSync(join(plugin, 'node_modules'), { recursive: true, force: true }); if (!hadLock) rmSync(join(plugin, 'package-lock.json'), { force: true }); rmSync(temp, { recursive: true, force: true }) }
