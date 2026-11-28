import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri/resources/bin')
const ENTRY = 'versions/current/node_modules/@open-mercato/cezar/dist/index.js'
// Echoes its argv as JSON and exits with the status named by CEZ_TEST_EXIT.
const FAKE_CEZAR = 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.CEZ_TEST_EXIT ?? 0))\n'

let root
let home

function install(at = home) {
  const entry = path.join(at, ENTRY)
  mkdirSync(path.dirname(entry), { recursive: true })
  writeFileSync(entry, FAKE_CEZAR)
}

// A PATH with the shim's own tools and no `node` (CI images put one in /usr/bin or /usr/local/bin).
function noNodePath(extra = []) {
  const tools = path.join(root, 'tools')
  mkdirSync(tools, { recursive: true })
  for (const tool of ['ls', 'sort']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    symlinkSync(found, path.join(tools, tool))
  }
  return [...extra, tools].join(':')
}

function cez(args, env = {}, name = 'cez') {
  return spawnSync(path.join(bin, name), args, {
    encoding: 'utf8',
    env: { HOME: root, PATH: process.env.PATH, CEZ_HOME: home, ...env },
  })
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cez-shim-'))
  home = path.join(root, '.cezar')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(process.platform === 'win32')('Cezar.app cez shim', () => {
  it('passes every argument through unchanged', () => {
    install()
    const args = ['run', 'two words', "it's", '--flag=a b', '', '$HOME', '*']
    const result = cez(args)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it('passes the exit status through', () => {
    install()
    expect(cez(['x'], { CEZ_TEST_EXIT: '3' }).status).toBe(3)
    expect(cez(['x'], { CEZ_TEST_EXIT: '75' }).status).toBe(75)
  })

  it('says to open the app when cezar is not installed yet', () => {
    const result = cez(['--help'])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Open Cezar once to finish setup')
  })

  it('defaults to ~/.cezar and respects CEZ_HOME', () => {
    install(path.join(root, '.cezar'))
    expect(cez(['a'], { CEZ_HOME: '' }).status).toBe(0)
    expect(cez(['a'], { CEZ_HOME: path.join(root, 'elsewhere') }).status).not.toBe(0)
  })

  it('is the same program as cezar', () => {
    expect(readlinkSync(path.join(bin, 'cezar'))).toBe('cez')
    install()
    expect(JSON.parse(cez(['b'], {}, 'cezar').stdout)).toEqual(['b'])
  })

  it('works through a symlink, as /usr/local/bin and brew link it', () => {
    install()
    const link = path.join(root, 'cez')
    symlinkSync(path.join(bin, 'cez'), link)
    const result = spawnSync(link, ['c'], { encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH, CEZ_HOME: home } })
    expect(JSON.parse(result.stdout)).toEqual(['c'])
  })

  it("falls back to the app's own Node when PATH has none", () => {
    install()
    const managed = path.join(home, 'node', '22.11.0')
    mkdirSync(path.join(managed, 'bin'), { recursive: true })
    writeFileSync(path.join(managed, '.cezar-node.json'), '{}\n')
    symlinkSync(process.execPath, path.join(managed, 'bin', 'node'))
    expect(cez(['d'], { PATH: noNodePath() }).stdout).toContain('["d"]')

    rmSync(path.join(home, 'node'), { recursive: true })
    const result = cez(['d'], { PATH: path.join(root, 'tools') })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Node.js 20 or newer was not found')
  })

  it('skips a Node older than 20 on PATH', () => {
    install()
    const old = path.join(root, 'old')
    mkdirSync(old)
    writeFileSync(path.join(old, 'node'), '#!/bin/sh\necho 18\n')
    chmodSync(path.join(old, 'node'), 0o755)
    const result = cez(['e'], { PATH: noNodePath([old]) })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Node.js 20 or newer was not found')
  })
})
