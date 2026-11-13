import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { ExtensionInstaller, assertWithinLimits, artifactIntegrity } from './installer.ts'
const exec = promisify(execFile)
const roots: string[] = []
const servers: Server[] = []
const originalEnv = { ...process.env }
afterEach(async () => {
  process.env = { ...originalEnv }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'install-security-')); roots.push(root)
  const source = join(root, 'source'); await mkdir(source)
  const manifest = { id: 'fixture', name: 'Fixture', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] }
  await writeFile(join(source, 'cezar-extension.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'index.mjs'), 'export {}')
  return { root, source, manifest }
}
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
it.each(['direct', 'redirect'])('never requests a forbidden %s dependency during real resolution', async kind => {
  const { root, source } = await fixture()
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
  await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: source, timeout: 30_000 })
  const tarball = await readFile(join(root, 'dep-1.0.0.tgz'))
  let forbidden = 0
  const outside = await listen(createServer((_req, res) => { forbidden++; res.end(tarball) }))
  let registry = ''
  registry = await listen(createServer((req, res) => {
    if (req.url === '/redirect.tgz') { res.writeHead(302, { location: `${outside}/dep.tgz` }); res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: 'fixture', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {
      name: 'fixture', version: '1.0.0', dependencies: { dep: kind === 'direct' ? `${outside}/dep.tgz` : `${registry}/redirect.tgz` },
      dist: { tarball: `${registry}/fixture.tgz`, integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` },
    } } }))
  }))
  process.env.npm_config_registry = registry
  process.env.npm_config_cache = join(root, 'external-cache')
  process.env.npm_config_userconfig = join(root, 'no-user-config')
  process.env.npm_config_globalconfig = join(root, 'no-global-config')
  const installer = new ExtensionInstaller(join(root, 'home'), { files: 100, bytes: 1024 * 1024 })
  await expect(installer.prepareInstall('fixture')).rejects.toThrow()
  expect(forbidden).toBe(0)
  expect(await readdir(join(root, 'home/extensions/.staging'))).toEqual([])
  // The resolver may query npm config, but must never populate npm's content cache.
  expect(await readdir(join(root, 'external-cache/_cacache')).catch(() => [])).toEqual([])
}, 60_000)
it('rejects a FIFO manifest without waiting for a writer', async () => {
  const name = 'cezar-extension.json'
  const { root, source, manifest } = await fixture()
  await rm(join(source, 'cezar-extension.json'))
  await exec('mkfifo', [join(source, name)], { timeout: 5_000 })
  const promise = new ExtensionInstaller(join(root, 'home')).prepareInstall(source).then(() => 'accepted', () => 'rejected')
  const result = await Promise.race([promise, new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 500))])
  // Unblock the vulnerable implementation, so the RED test cannot leak a blocked fs worker.
  if (result === 'blocked') { await writeFile(join(source, name), JSON.stringify(manifest)); await promise }
  expect(result).toBe('rejected')
})
it.each(['preflight', 'integrity', 'install'])('%s counts empty directories', async operation => {
  const { root, source } = await fixture()
  for (let i = 0; i < 8; i++) await mkdir(join(source, `empty-${i}`))
  const limits = { files: 3, bytes: 1024 }
  const action = operation === 'preflight' ? assertWithinLimits(source, limits) : operation === 'integrity' ? artifactIntegrity(source, undefined, limits) : new ExtensionInstaller(join(root, 'home'), limits).prepareInstall(source)
  await expect(action).rejects.toThrow('limits')
})

it('bounds a regular manifest before full-buffer parsing', async () => {
  const { root, source, manifest } = await fixture()
  await writeFile(join(source, 'cezar-extension.json'), JSON.stringify(manifest) + ' '.repeat(1024 * 1024))
  await expect(new ExtensionInstaller(join(root, 'home')).prepareInstall(source)).rejects.toThrow('limits')
})
