import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const example = resolve(sdk, '../../examples/extensions/project-summary')
// The host smoke below packs the service with --ignore-scripts, so it must already be built.
if (!existsSync(resolve(sdk, '../cezar/dist/extensions/manager.js'))) {
  console.error('pack-smoke: packages/cezar/dist is missing — run `npm run build` at the repository root first.')
  process.exit(1)
}
const temp = mkdtempSync(join(tmpdir(), 'cezar-sdk-pack-'))
// npm forwards workspace configuration to lifecycle scripts; it is not valid
// for an unrelated consumer install. Install scripts remain explicitly disabled.
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
}
const run = (bin, args, cwd) => execFileSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], sdk))
  const tarball = join(temp, packed[0].filename)
  if (packed[0].files.some(file => file.path.startsWith('src/'))) throw Error('Tarball must ship built artifacts')
  if ('./source' in JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json'], temp)).exports) throw Error('Tarball must not export ./source')
  const project = join(temp, 'consumer')
  cpSync(example, project, { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/dist') })
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  pkg.dependencies['@open-mercato/cezar-extension-sdk'] = tarball
  writeFileSync(join(project, 'package.json'), JSON.stringify(pkg))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], project)
  run(process.execPath, [join(project, 'node_modules/typescript/bin/tsc')], project)
  // The example ships its own lifecycle tests (every placement, tasks.get, tasks.propose, dispose);
  // here they run against the packed SDK instead of the workspace symlink.
  run(process.execPath, ['--test', 'test/extension.test.mjs'], project)
  const chatProject = join(temp, 'mattermost')
  cpSync(resolve(sdk, '../../examples/extensions/mattermost'), chatProject, { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/dist') })
  const chatPkg = JSON.parse(readFileSync(join(chatProject, 'package.json'), 'utf8'))
  chatPkg.dependencies['@open-mercato/cezar-extension-sdk'] = tarball
  writeFileSync(join(chatProject, 'package.json'), JSON.stringify(chatPkg))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], chatProject)
  run(process.execPath, [join(chatProject, 'node_modules/typescript/bin/tsc')], chatProject)
  // Exercise the maintained adapter fixtures against the public tarball.
  run(process.execPath, ['--test', 'test/adapter.test.mjs', 'test/cancellation.test.mjs'], chatProject)
  // Install the published-shape service too: private workspace packages must not
  // accidentally satisfy runtime imports in this external consumer.
  const service = resolve(sdk, '../cezar')
  const servicePack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], service))
  const cockpit = join(temp, 'cockpit'); mkdirSync(cockpit)
  writeFileSync(join(cockpit, 'package.json'), JSON.stringify({ name: 'extension-pack-host', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', join(temp, servicePack[0].filename)], cockpit)
  writeFileSync(join(cockpit, 'host-smoke.mjs'), `
import assert from 'node:assert/strict'
import { ExtensionManager } from './node_modules/@open-mercato/cezar/dist/extensions/manager.js'
const manager = new ExtensionManager(${JSON.stringify(join(temp, 'data'))}, 'external', ${JSON.stringify(temp)}, {
 home: ${JSON.stringify(join(temp, 'home'))}, listTasks: async () => [{ id: 'pack-task', title: 'Packed host', status: 'done' }],
})
try {
 const record = await manager.install(${JSON.stringify(project)})
 await manager.setEnabled(record.manifest.id, true, record.integrity)
 const panel = await manager.panel(record.manifest.id, 'summary')
 assert.equal(panel.blocks[0].rows[0][0], 'Packed host')
 await manager.setEnabled(record.manifest.id, false)
 await assert.rejects(manager.panel(record.manifest.id, 'summary'), /enabled/)
} finally { await manager.close() }
`)
  run(process.execPath, ['host-smoke.mjs'], cockpit)
  console.log('PASS: installed Cezar tarball activates the external SDK-built extension in a real worker without workspace dependencies')
  console.log('PASS: Mattermost example built outside workspace and exercised identity, discovery, receiveSession, send and membership with the public SDK')
  console.log('PASS: packed SDK installed outside workspace; project-summary typechecked and its placement tests (Settings, sidebar, palette, task) passed')
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  rmSync(temp, { recursive: true, force: true })
}
