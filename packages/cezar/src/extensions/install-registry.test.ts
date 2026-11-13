import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import tar from 'tar-stream'
type ArchiveHeader = Parameters<ReturnType<typeof tar.pack>['entry']>[0]
import { ExtensionInstaller } from './installer.ts'
import { extractRegistryArchive } from './install-archive.ts'
import { InstallBudget, copyArtifact, readRegular } from './install-files.ts'

const roots: string[] = [], servers: Server[] = []
const env = { ...process.env }
afterEach(async () => {
  process.env = { ...env }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function root() { const path = await mkdtemp(join(tmpdir(), 'install-registry-')); roots.push(path); return path }
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function archive(entries: { header: ArchiveHeader; body?: string | Buffer }[]) {
  const pack = tar.pack(), chunks: Buffer[] = []
  const consume = (async () => { for await (const chunk of pack) chunks.push(chunk as Buffer) })()
  for (const entry of entries) pack.entry(entry.header, entry.body ?? '')
  pack.finalize(); await consume
  return gzipSync(Buffer.concat(chunks))
}
const manifest = { id: 'fixture', name: 'Fixture', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] }
type Package = { name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional: boolean }> }
async function registryFixture(packages: Package[], options: { metadataRedirect?: string; tarRedirect?: string; extraBytes?: number; badIntegrity?: boolean } = {}) {
  const home = await root(), requests: string[] = []
  const archives = new Map<string, Buffer>()
  for (const pkg of packages) archives.set(`${pkg.name}@${pkg.version}`, await archive([
    { header: { name: 'package/package.json' }, body: JSON.stringify(pkg) },
    { header: { name: 'package/cezar-extension.json' }, body: JSON.stringify(manifest) },
    { header: { name: 'package/index.mjs' }, body: 'export default 42' },
    ...(options.extraBytes ? [{ header: { name: 'package/extra' }, body: Buffer.alloc(options.extraBytes) }] : []),
  ]))
  let url = ''
  url = await listen(createServer((req, res) => {
    const path = decodeURIComponent(req.url!.slice(1)); requests.push(path)
    const redirect = path.endsWith('.tgz') ? options.tarRedirect : options.metadataRedirect
    if (redirect) { res.writeHead(302, { location: redirect }); res.end(); return }
    if (path.endsWith('.tgz')) { res.end(archives.get(path.slice(0, -4))); return }
    const versions = Object.fromEntries(packages.filter(pkg => pkg.name === path).map(pkg => {
      const key = `${pkg.name}@${pkg.version}`, bytes = archives.get(key)!
      return [pkg.version, { ...pkg, dist: { tarball: `${url}/${encodeURIComponent(key)}.tgz`, integrity: `sha512-${createHash('sha512').update(options.badIntegrity ? 'wrong' : bytes).digest('base64')}` } }]
    }))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: path, 'dist-tags': { latest: Object.keys(versions).at(-1) }, versions }))
  }))
  process.env.npm_config_registry = url
  process.env.npm_config_cache = join(home, 'ambient-cache')
  process.env.npm_config_userconfig = join(home, 'no-user-config')
  process.env.npm_config_globalconfig = join(home, 'no-global-config')
  return { home, requests, url }
}
it('resolves ranges, scoped aliases, peers, optional peers and circular registry dependencies', async () => {
  const { home, requests } = await registryFixture([
    { name: 'fixture', version: '1.0.0', dependencies: { dep: '^1.0.0', alias: 'npm:@scope/target@~2.0' }, peerDependencies: { peer: '^3', absent: '*' }, peerDependenciesMeta: { absent: { optional: true } } },
    { name: 'dep', version: '1.0.0' },
    { name: 'dep', version: '1.2.0', dependencies: { fixture: 'latest' } },
    { name: '@scope/target', version: '2.0.1' },
    { name: 'peer', version: '3.0.0' },
  ])
  const installer = new ExtensionInstaller(home)
  const prepared = await installer.prepareInstall('fixture')
  const pkg = async (path: string) => JSON.parse(await readFile(join(prepared.artifactDir, path, 'package.json'), 'utf8')) as Package
  expect((await pkg('node_modules/dep')).version).toBe('1.2.0')
  expect((await pkg('node_modules/alias')).name).toBe('@scope/target')
  expect((await pkg('node_modules/peer')).version).toBe('3.0.0')
  expect((await pkg('node_modules/fixture')).name).toBe('fixture')
  expect(requests).not.toContain('absent')
  expect(requests.filter(path => path === 'fixture')).toHaveLength(1)
  expect(await readdir(join(home, 'ambient-cache')).catch(() => [])).toEqual([])
  await installer.commitInstall(prepared)
})
it.each(['metadataRedirect', 'tarRedirect'] as const)('blocks cross-origin %s before the target is requested', async key => {
  let forbidden = 0
  const outside = await listen(createServer((_req, res) => { forbidden++; res.end('forbidden') }))
  const { home } = await registryFixture([{ name: 'fixture', version: '1.0.0' }], { [key]: outside })
  await expect(new ExtensionInstaller(home).prepareInstall('fixture')).rejects.toThrow('redirect leaves')
  expect(forbidden).toBe(0)
  expect(await readdir(join(home, 'extensions/.staging'))).toEqual([])
})
it('offline makes zero registry requests; local folders still work', async () => {
  const { home, requests } = await registryFixture([{ name: 'fixture', version: '1.0.0' }])
  process.env.npm_config_offline = 'true'
  const installer = new ExtensionInstaller(home)
  await expect(installer.prepareInstall('fixture')).rejects.toThrow('offline')
  expect(requests).toEqual([])
  const source = join(home, 'source'); await mkdir(source)
  await writeFile(join(source, 'cezar-extension.json'), JSON.stringify(manifest)); await writeFile(join(source, 'index.mjs'), '')
  await installer.commitInstall(await installer.prepareInstall(source))
})
it('bounds decompressed archives before writing a large entry and cleans staging', async () => {
  const { home } = await registryFixture([{ name: 'fixture', version: '1.0.0' }], { extraBytes: 100_000 })
  await expect(new ExtensionInstaller(home, { files: 100, bytes: 8_192 }).prepareInstall('fixture')).rejects.toThrow('limits')
  expect(await readdir(join(home, 'extensions/.staging'))).toEqual([])
  expect(await readdir(join(home, 'ambient-cache')).catch(() => [])).toEqual([])
})
it.each([
  { name: 'package/../../outside', type: 'file' as const },
  { name: '/package/absolute', type: 'file' as const },
  { name: 'package/CON', type: 'file' as const },
  { name: 'package/file:stream', type: 'file' as const },
  { name: 'package/link', type: 'symlink' as const, linkname: '/tmp/outside' },
  { name: 'package/pipe', type: 'fifo' as const },
  { name: 'package/a/b/c/d/file', type: 'file' as const },
])('rejects unsafe archive header $name ($type)', async header => {
  const home = await root(), file = join(home, 'archive.tgz')
  await writeFile(file, await archive([{ header }]))
  await expect(extractRegistryArchive(file, join(home, 'output'), new InstallBudget({ files: 10, bytes: 8192, depth: 3 }))).rejects.toThrow()
})
it('counts empty directory entries during extraction, and accounts for package nesting depth', async () => {
  const home = await root(), file = join(home, 'archive.tgz')
  await writeFile(file, await archive(Array.from({ length: 4 }, (_, i) => ({ header: { name: `package/dir${i}`, type: 'directory' } }))))
  await expect(extractRegistryArchive(file, join(home, 'output'), new InstallBudget({ files: 3, bytes: 8192 }))).rejects.toThrow('limits')
  await writeFile(file, await archive([{ header: { name: 'package/a/b', type: 'directory' } }]))
  await expect(extractRegistryArchive(file, join(home, 'nested'), new InstallBudget({ files: 10, bytes: 8192, depth: 3 }), 2)).rejects.toThrow('limits')
})
it('bounds directories and depth during copying, without relying on a preflight', async () => {
  const home = await root(), source = join(home, 'source'); await mkdir(join(source, 'a/b/c/d'), { recursive: true })
  await expect(copyArtifact(source, join(home, 'copy'), new InstallBudget({ files: 2, bytes: 8192 }))).rejects.toThrow('limits')
  await expect(copyArtifact(source, join(home, 'copy-depth'), new InstallBudget({ files: 10, bytes: 8192, depth: 2 }))).rejects.toThrow('limits')
})
it('bounds manifest bytes before reading', async () => {
  const home = await root(), file = join(home, 'manifest.json')
  await writeFile(file, Buffer.alloc(1025))
  await expect(readRegular(file, 1024)).rejects.toThrow('limits')
})

it('bounds streamed downloads without Content-Length and removes partial cache files', async () => {
  const { downloadRegistryArtifact } = await import('./install-network.ts')
  const home = await root(), path = join(home, 'download')
  const url = await listen(createServer((_req, res) => { res.write(Buffer.alloc(512)); res.end(Buffer.alloc(1024)) }))
  await expect(downloadRegistryArtifact(url, url, path, 1024)).rejects.toThrow('limits')
  expect(await readdir(home)).toEqual([])
})
it('bounds aggregate metadata and archives across dependencies, with no ambient cache', async () => {
  const packages: Package[] = [{ name: 'fixture', version: '1.0.0', dependencies: { a: '1', b: '1', c: '1' } }, ...['a', 'b', 'c'].map(name => ({ name, version: '1.0.0' }))]
  const { home, requests } = await registryFixture(packages)
  await expect(new ExtensionInstaller(home, { files: 100, bytes: 1800 }).prepareInstall('fixture')).rejects.toThrow('limits')
  expect(requests.filter(path => path.endsWith('.tgz')).length).toBeLessThan(4)
  expect(await readdir(join(home, 'extensions/.staging'))).toEqual([])
  expect(await readdir(join(home, 'ambient-cache')).catch(() => [])).toEqual([])
})
it('allows same-origin redirects and stops a redirect loop after six requests', async () => {
  const { downloadRegistryArtifact } = await import('./install-network.ts')
  const home = await root(), path = join(home, 'download')
  let calls = 0
  const url = await listen(createServer((req, res) => {
    calls++
    if (req.url === '/ok') { res.end('ok'); return }
    res.writeHead(302, { location: req.url === '/start' ? '/ok' : '/loop' }); res.end()
  }))
  await downloadRegistryArtifact(`${url}/start`, url, path, 2)
  expect(await readFile(path, 'utf8')).toBe('ok')
  calls = 0
  await expect(downloadRegistryArtifact(`${url}/loop`, url, join(home, 'loop'), 2)).rejects.toThrow('too many redirects')
  expect(calls).toBe(6)
})
it('an aborted download stops before sending a request', async () => {
  const { downloadRegistryArtifact } = await import('./install-network.ts')
  const home = await root(); let calls = 0
  const url = await listen(createServer((_req, res) => { calls++; res.end('ok') }))
  await expect(downloadRegistryArtifact(url, url, join(home, 'download'), 100, AbortSignal.abort())).rejects.toThrow()
  expect(calls).toBe(0)
})

it('shares a peer with its consumer instead of creating private duplicate instances', async () => {
  const { home } = await registryFixture([
    { name: 'fixture', version: '1.0.0', dependencies: { dep: '1', peer: '2' } },
    { name: 'dep', version: '1.0.0', peerDependencies: { peer: '^2' } },
    { name: 'peer', version: '2.0.0' },
  ])
  const prepared = await new ExtensionInstaller(home).prepareInstall('fixture')
  expect(await readdir(join(prepared.artifactDir, 'node_modules/dep/node_modules')).catch(() => [])).toEqual([])
  expect(JSON.parse(await readFile(join(prepared.artifactDir, 'node_modules/peer/package.json'), 'utf8')).version).toBe('2.0.0')
})
it('installs an absent required peer alongside its consumer and rejects incompatible peers', async () => {
  const { home } = await registryFixture([
    { name: 'fixture', version: '1.0.0', dependencies: { dep: '1' } },
    { name: 'dep', version: '1.0.0', peerDependencies: { peer: '^2' } },
    { name: 'peer', version: '2.0.0' },
  ])
  const prepared = await new ExtensionInstaller(home).prepareInstall('fixture')
  expect(JSON.parse(await readFile(join(prepared.artifactDir, 'node_modules/peer/package.json'), 'utf8')).version).toBe('2.0.0')
  const conflict = await registryFixture([
    { name: 'fixture', version: '1.0.0', dependencies: { dep: '1', peer: '3' } },
    { name: 'dep', version: '1.0.0', peerDependencies: { peer: '^2' } },
    { name: 'peer', version: '3.0.0' },
  ])
  await expect(new ExtensionInstaller(conflict.home).prepareInstall('fixture')).rejects.toThrow('incompatible extension peer')
})

it('rejects linked manifests before following their targets', async () => {
  const home = await root(), target = join(home, 'target'), link = join(home, 'manifest.json')
  await writeFile(target, '{}'); await symlink(target, link)
  await expect(readRegular(link, 1024)).rejects.toThrow('symbolic link')
})

it('verifies registry integrity before extracting any archive content', async () => {
  const { home } = await registryFixture([{ name: 'fixture', version: '1.0.0' }], { badIntegrity: true })
  await expect(new ExtensionInstaller(home).prepareInstall('fixture')).rejects.toThrow('integrity mismatch')
  expect(await readdir(join(home, 'extensions/.staging'))).toEqual([])
})

type Served = Package & { hasInstallScript?: boolean }
/** One loopback registry serving `packages`; tarballs default to its own origin. */
async function registryServer(packages: Served[], options: { tarballOrigin?: () => string; padding?: number } = {}) {
  const requests: string[] = [], accepts: string[] = []
  const archives = new Map<string, Buffer>()
  for (const { hasInstallScript: _, ...pkg } of packages) archives.set(`${pkg.name}@${pkg.version}`, await archive([
    { header: { name: 'package/package.json' }, body: JSON.stringify(pkg) },
    { header: { name: 'package/cezar-extension.json' }, body: JSON.stringify({ ...manifest, version: pkg.version }) },
    { header: { name: 'package/index.mjs' }, body: 'export default 42' },
  ]))
  let url = ''
  url = await listen(createServer((req, res) => {
    const path = decodeURIComponent(req.url!.slice(1)); requests.push(path)
    if (path.endsWith('.tgz')) { const body = archives.get(path.slice(0, -4)); if (!body) res.statusCode = 404; res.end(body); return }
    accepts.push(req.headers.accept ?? '')
    const matching = packages.filter(pkg => pkg.name === path)
    if (!matching.length) { res.statusCode = 404; res.end('{}'); return }
    const versions = Object.fromEntries(matching.map(pkg => {
      const key = `${pkg.name}@${pkg.version}`
      return [pkg.version, { ...pkg, dist: { tarball: `${options.tarballOrigin?.() ?? url}/${encodeURIComponent(key)}.tgz`, integrity: `sha512-${createHash('sha512').update(archives.get(key)!).digest('base64')}` } }]
    }))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: path, 'dist-tags': { latest: Object.keys(versions).at(-1) }, versions, ...(options.padding ? { readme: 'x'.repeat(options.padding) } : {}) }))
  }))
  return { url, requests, accepts }
}
/** A real user npmrc (not env overrides), as a user with a private scope would have it. */
async function userNpmrc(home: string, lines: string[]) {
  const file = join(home, 'npmrc'); await writeFile(file, `${lines.join('\n')}\n`)
  delete process.env.npm_config_registry
  process.env.npm_config_userconfig = file
  process.env.npm_config_globalconfig = join(home, 'no-global-config')
  process.env.npm_config_cache = join(home, 'ambient-cache')
}

it('resolves a scoped package and its scoped dependencies only from the scope registry', async () => {
  const home = await root()
  // The public registry also publishes an @acme/ext: dependency confusion if it were ever asked.
  const publicRegistry = await registryServer([
    { name: '@acme/ext', version: '9.9.9' }, { name: '@acme/util', version: '9.9.9' }, { name: 'plain', version: '1.0.0' },
  ])
  const scoped = await registryServer([
    { name: '@acme/ext', version: '1.0.0', dependencies: { '@acme/util': '^1', plain: '1' } },
    { name: '@acme/util', version: '1.0.0' },
  ])
  await userNpmrc(home, [`registry=${publicRegistry.url}/`, `@acme:registry=${scoped.url}/`])
  const prepared = await new ExtensionInstaller(home).prepareInstall('@acme/ext')
  expect(prepared.resolvedVersion).toBe('1.0.0')
  expect(JSON.parse(await readFile(join(prepared.artifactDir, 'node_modules/@acme/util/package.json'), 'utf8')).version).toBe('1.0.0')
  expect(publicRegistry.requests.filter(path => path.startsWith('@acme'))).toEqual([])
  expect(publicRegistry.requests).toContain('plain')
  expect(scoped.requests).not.toContain('plain')
})
it('rejects a scoped tarball outside its scope registry, never falling back to the default one', async () => {
  const home = await root()
  const publicRegistry = await registryServer([{ name: '@acme/ext', version: '1.0.0' }])
  const scoped = await registryServer([{ name: '@acme/ext', version: '1.0.0' }], { tarballOrigin: () => publicRegistry.url })
  await userNpmrc(home, [`registry=${publicRegistry.url}/`, `@acme:registry=${scoped.url}/`])
  await expect(new ExtensionInstaller(home).prepareInstall('@acme/ext')).rejects.toThrow('integrity-pinned registry artifacts')
  expect(publicRegistry.requests).toEqual([])
})
// `npm config list --json` omits a scope registry its redactor deems secret.
const hiddenScopeUrls = [
  'https://user:pw@127.0.0.1:1/',
  'https://127.0.0.1:1/0123abcd-0123-4567-89ab-0123456789ab/',
  `https://127.0.0.1:1/npm_${'a'.repeat(36)}/`,
]
it.each(hiddenScopeUrls)('refuses a scope whose registry npm redacts (%s), never asking the default registry', async scopeUrl => {
  const home = await root()
  const publicRegistry = await registryServer([{ name: '@acme/ext', version: '9.9.9' }])
  await userNpmrc(home, [`registry=${publicRegistry.url}/`, `@acme:registry=${scopeUrl}`])
  const error = await new ExtensionInstaller(home).prepareInstall('@acme/ext').catch((caught: Error) => caught)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(/@acme.*without embedded credentials/)
  expect((error as Error).message).not.toMatch(/pw|0123abcd|npm_a/)
  expect(publicRegistry.requests).toEqual([])
  expect(await readdir(join(home, 'extensions/.staging'))).toEqual([])
})
it('refuses a transitive dependency in a redacted scope the same way', async () => {
  const home = await root()
  const publicRegistry = await registryServer([
    { name: 'fixture', version: '1.0.0', dependencies: { '@acme/util': '^1' } }, { name: '@acme/util', version: '1.0.0' },
  ])
  await userNpmrc(home, [`registry=${publicRegistry.url}/`, `@acme:registry=${hiddenScopeUrls[0]}`])
  await expect(new ExtensionInstaller(home).prepareInstall('fixture')).rejects.toThrow(/@acme.*without embedded credentials/)
  expect(publicRegistry.requests.filter(path => path.includes('@acme'))).toEqual([])
  expect(publicRegistry.requests.filter(path => path.endsWith('.tgz'))).toEqual([])
})
it('refuses an aliased dependency into a redacted scope', async () => {
  const home = await root()
  const publicRegistry = await registryServer([
    { name: 'fixture', version: '1.0.0', dependencies: { util: 'npm:@acme/util@^1' } }, { name: '@acme/util', version: '1.0.0' },
  ])
  await userNpmrc(home, [`registry=${publicRegistry.url}/`, `@acme:registry=${hiddenScopeUrls[1]}`])
  await expect(new ExtensionInstaller(home).prepareInstall('fixture')).rejects.toThrow(/@acme.*without embedded credentials/)
  expect(publicRegistry.requests.filter(path => path.includes('@acme'))).toEqual([])
})
it('caps cumulative parsed registry metadata separately from the download budget', async () => {
  const home = await root()
  const registry = await registryServer([
    { name: 'fixture', version: '1.0.0', dependencies: { a: '1', b: '1', c: '1' } },
    ...['a', 'b', 'c'].map(name => ({ name, version: '1.0.0' })),
  ], { padding: 10_000 })
  await userNpmrc(home, [`registry=${registry.url}/`])
  await expect(new ExtensionInstaller(home, { files: 100, bytes: 1024 * 1024, metadata: 25_000 }).prepareInstall('fixture')).rejects.toThrow('limits')
  expect(registry.requests.filter(path => !path.endsWith('.tgz')).length).toBeLessThanOrEqual(3)
  expect(registry.requests.filter(path => path.endsWith('.tgz'))).toEqual([])
  expect(await readdir(join(home, 'extensions/.staging'))).toEqual([])
  // The same tree fits the default cap.
  await new ExtensionInstaller(home, { files: 100, bytes: 1024 * 1024 }).prepareInstall('fixture')
})
it('asks for abbreviated packuments and honours their install-script flag', async () => {
  const home = await root()
  const registry = await registryServer([
    { name: 'fixture', version: '1.0.0', dependencies: { native: '1' } },
    // Abbreviated documents omit `scripts`; a binding.gyp-only package has no script in its archive either.
    { name: 'native', version: '1.0.0', hasInstallScript: true },
  ])
  await userNpmrc(home, [`registry=${registry.url}/`])
  await expect(new ExtensionInstaller(home).prepareInstall('fixture')).rejects.toThrow('lifecycle installation scripts')
  expect(registry.accepts[0]).toContain('application/vnd.npm.install-v1+json')
  expect(registry.requests.filter(path => path.endsWith('.tgz'))).toEqual([])
})
it('rejects an oversized PAX header without buffering it into an entry', async () => {
  const home = await root(), file = join(home, 'archive.tgz')
  await writeFile(file, await archive([{ header: { name: 'package/index.mjs', pax: { comment: 'x'.repeat(5 * 1024 * 1024) } } }]))
  await expect(extractRegistryArchive(file, join(home, 'output'), new InstallBudget({ files: 10, bytes: 64 * 1024 * 1024 }))).rejects.toThrow()
  expect(await readdir(join(home, 'output')).catch(() => [])).toEqual([])
})
