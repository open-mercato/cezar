import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ExtensionInstaller } from './installer.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'extension-install-')); roots.push(root)
  const source = join(root, 'source'); await mkdir(source)
  const manifest = { id: 'fixture', name: 'Fixture', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] }
  await writeFile(join(source, 'cezar-extension.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'index.mjs'), 'throw new Error("must never execute")')
  return { root, source, manifest, installer: new ExtensionInstaller(join(root, 'home')) }
}
describe('extension artifact installation', () => {
  it('stages a snapshot and atomically installs immutable same-version reloads', async () => {
    const { source, installer } = await fixture()
    const prepared = await installer.prepareInstall(source)
    await writeFile(join(source, 'index.mjs'), 'changed')
    const installed = await installer.commitInstall(prepared)
    expect(await readFile(join(installed.path, 'index.mjs'), 'utf8')).toContain('must never execute')
    const reload = await installer.commitInstall(await installer.prepareInstall(source))
    expect(reload.path).not.toBe(installed.path)
    expect(installed.integrity).toMatch(/^sha512-/)
  })
  it('serializesConcurrentInstall across installer instances', async () => {
    const { source, root, installer } = await fixture()
    const other = new ExtensionInstaller(join(root, 'home'))
    const [a, b] = await Promise.all([installer.prepareInstall(source), other.prepareInstall(source)])
    const results = await Promise.all([installer.commitInstall(a), other.commitInstall(b)])
    expect(results[0]!.path).toBe(results[1]!.path)
  })
  it('verifies an artifact already at the target instead of replacing it (guard)', async () => {
    const { source, installer } = await fixture()
    const installed = await installer.commitInstall(await installer.prepareInstall(source))
    await writeFile(join(installed.path, 'index.mjs'), 'tampered in place')
    await expect(installer.commitInstall(await installer.prepareInstall(source))).rejects.toThrow('integrity mismatch')
    expect(await readFile(join(installed.path, 'index.mjs'), 'utf8')).toBe('tampered in place')
  })
  it('sweeps only stale staging directories on the next prepare (guard)', async () => {
    const { root, source, installer } = await fixture()
    const staging = join(root, 'home', 'extensions', '.staging')
    await mkdir(join(staging, 'install-stale'), { recursive: true }); await mkdir(join(staging, 'install-fresh'))
    const old = new Date(Date.now() - 2 * 60 * 60_000); await utimes(join(staging, 'install-stale'), old, old)
    const prepared = await installer.prepareInstall(source)
    const left = await readdir(staging)
    expect(left).toContain('install-fresh'); expect(left).not.toContain('install-stale')
    await installer.discardInstall(prepared)
  })
  it('rejects staged tampering and forged preparations', async () => {
    const { source, installer } = await fixture()
    const prepared = await installer.prepareInstall(source)
    await writeFile(join(prepared.artifactDir, 'index.mjs'), 'tampered')
    await expect(installer.commitInstall(prepared)).rejects.toThrow('changed after preview')
    await installer.discardInstall(prepared)
    await expect(installer.commitInstall(prepared)).rejects.toThrow('expired')
  })
  it('rejectsArtifactPathEscape, version traversal and symlink files', async () => {
    const { source, installer, manifest } = await fixture()
    for (const change of [{ entry: '../outside.mjs' }, { version: '../../escape' }]) {
      await writeFile(join(source, 'cezar-extension.json'), JSON.stringify({ ...manifest, ...change }))
      await expect(installer.prepareInstall(source)).rejects.toThrow()
    }
    await writeFile(join(source, 'cezar-extension.json'), JSON.stringify(manifest))
    await symlink('/etc/passwd', join(source, 'link'))
    await expect(installer.prepareInstall(source)).rejects.toThrow('symbolic link')
  })
  it('installs a folder after a default npm install, leaving node_modules/.bin shims out', async () => {
    const { source, installer } = await fixture()
    await mkdir(join(source, 'node_modules/typescript/bin'), { recursive: true })
    await writeFile(join(source, 'node_modules/typescript/bin/tsc'), '#!/usr/bin/env node')
    await mkdir(join(source, 'node_modules/.bin'))
    await symlink('../typescript/bin/tsc', join(source, 'node_modules/.bin/tsc'))
    await symlink('/etc/passwd', join(source, 'node_modules/.bin/escape'))
    await mkdir(join(source, 'node_modules/typescript/node_modules/.bin'), { recursive: true })
    await symlink('../../bin/tsc', join(source, 'node_modules/typescript/node_modules/.bin/nested'))
    const installed = await installer.commitInstall(await installer.prepareInstall(source))
    expect(await readdir(join(installed.path, 'node_modules'))).toEqual(['typescript'])
    expect(await readdir(join(installed.path, 'node_modules/typescript/node_modules'))).toEqual([])
    // Any other link, inside node_modules or out, is still refused.
    await symlink('/etc', join(source, 'node_modules/escape'))
    await expect(installer.prepareInstall(source)).rejects.toThrow('symbolic link')
    await rm(join(source, 'node_modules/escape'))
    await symlink('../outside', join(source, '.bin'))
    await expect(installer.prepareInstall(source)).rejects.toThrow('symbolic link')
  })
  it('reads the manifest before walking a local folder, so an arbitrary directory fails fast', async () => {
    const { root, installer } = await fixture()
    const folder = join(root, 'not-an-extension'); await mkdir(folder)
    // A walk would trip on this link first; the missing manifest must be what refuses the folder.
    await symlink('/etc', join(folder, 'link'))
    await expect(installer.prepareInstall(folder)).rejects.toThrow(/no manifest/)
  })
  it('refuses a local folder over the file cap before hashing or copying it', async () => {
    const { root, source } = await fixture()
    for (let i = 0; i < 5; i++) await writeFile(join(source, `extra-${i}.txt`), 'x')
    const installer = new ExtensionInstaller(join(root, 'home'), { files: 4, bytes: 1024 * 1024 })
    await expect(installer.prepareInstall(source)).rejects.toThrow('exceeds installation limits')
    expect(await readdir(join(root, 'home', 'extensions', '.staging'))).toEqual([])
  })
  it('rejects URL, git and tarball sources', async () => {
    const { installer } = await fixture()
    for (const source of ['https://example.com/a.tgz', 'git+https://example.com/x', './missing.tgz']) await expect(installer.prepareInstall(source)).rejects.toThrow('only npm')
  })
  it.each(['prepack', 'preinstall'])('never runs %s scripts when staging an exact registry artifact', async (script) => {
    const { root, source, installer } = await fixture()
    const marker = join(root, 'executed')
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { [script]: `node -e "require('fs').writeFileSync('${marker}', 'bad')"` } }))
    await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: source, timeout: 30_000 })
    const tarball = await readFile(join(root, 'fixture-1.0.0.tgz'))
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    let address = ''
    const server = createServer((req, res) => {
      if (req.url?.endsWith('.tgz')) { res.end(tarball); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: 'fixture', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'fixture', version: '1.0.0', dist: { tarball: `${address}/fixture.tgz`, integrity } } } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    address = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const prior = process.env.npm_config_registry
    process.env.npm_config_registry = address
    try {
      // npm's registry metadata omits scripts: archive scripts still must never run.
      if (script === 'preinstall') {
        await expect(installer.prepareInstall('fixture@1.0.0')).rejects.toThrow('unsupported lifecycle')
        expect(await readdir(root)).not.toContain('executed')
        return
      }
      const prepared = await installer.prepareInstall('fixture')
      expect(prepared.source).toBe('fixture')
      expect(prepared.packageIntegrity).toBe(integrity)
      expect(prepared.resolvedVersion).toBe('1.0.0')
      const installed = await installer.commitInstall(prepared)
      expect(await readFile(join(installed.path, '.cezar-package-lock.json'), 'utf8')).toContain(integrity)
      expect(await readdir(root)).not.toContain('executed')
    } finally {
      if (prior === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = prior
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 60_000)
})

describe('source classification', () => {
  it('reads package-shaped sources as npm packages, never as a same-named folder', async () => {
    const { isPackageSource } = await import('./installer.ts')
    expect(['probe', 'probe@1.2.3', '@acme/probe', '@acme/probe@^1'].filter(value => !isPackageSource(value))).toEqual([])
    expect(['./probe', '../probe', '/abs/probe', 'examples/extensions/hello', '.'].filter(isPackageSource)).toEqual([])
  })
  it('cancels the response body of every refused download', async () => {
    const { downloadRegistryArtifact } = await import('./install-network.ts')
    const origin = 'https://registry.npmjs.org'
    const cancel = vi.fn(async () => undefined)
    const response = (status: number, headers: Record<string, string>, ok: boolean, body: unknown) => ({
      status, headers: new Headers(headers), ok, body,
    }) as Response
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(302, {}, false, { cancel }))
      .mockResolvedValueOnce(response(302, { location: 'https://evil.example/a.tgz' }, false, { cancel }))
      .mockResolvedValueOnce(response(200, { 'content-length': '2' }, true, { cancel })))
    const destination = join(await mkdtemp(join(tmpdir(), 'extension-download-')), 'a.tgz')
    await expect(downloadRegistryArtifact('https://registry.npmjs.org/a.tgz', origin, destination, 1)).rejects.toThrow('no location')
    expect(cancel).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(302, { location: 'https://evil.example/a.tgz' }, false, { cancel })))
    await expect(downloadRegistryArtifact('https://registry.npmjs.org/a.tgz', origin, destination, 1)).rejects.toThrow('redirect leaves')
    expect(cancel).toHaveBeenCalledTimes(2)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { 'content-length': '2' }, true, { cancel })))
    await expect(downloadRegistryArtifact('https://registry.npmjs.org/a.tgz', origin, destination, 1)).rejects.toThrow('exceeds installation limits')
    expect(cancel).toHaveBeenCalledTimes(3)
  })
})
