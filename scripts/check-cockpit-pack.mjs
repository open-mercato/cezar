#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const consumerFixtureFiles = [
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'src/main.tsx',
]

const forbiddenRuntimeMarkers = [
  /packages[/\\]web/,
  /@open-mercato[/\\]cezar-web/,
  /#cezar-web-cockpit/,
  /src[/\\]cockpit-implementation/,
]

const runtimeFilePattern = /(?:\.(?:[cm]?js)|\.d\.[cm]?ts)$/
const cssUrlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g

export async function copyConsumerFixture(source, destination) {
  for (const relativePath of consumerFixtureFiles) {
    const target = path.join(destination, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(path.join(source, relativePath), target)
  }
  return [...consumerFixtureFiles]
}

async function runtimeFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
      } else if (entry.isFile() && runtimeFilePattern.test(entry.name)) {
        files.push(absolutePath)
      }
    }
  }
  await visit(root)
  return files.sort()
}

export async function scanInstalledRuntime(root) {
  const files = await runtimeFiles(root)
  for (const file of files) {
    const contents = await readFile(file, 'utf8')
    for (const marker of forbiddenRuntimeMarkers) {
      const match = contents.match(marker)
      if (match) {
        throw new Error(`private runtime marker ${JSON.stringify(match[0])} found in ${file}`)
      }
    }
  }
  return { filesScanned: files.length, forbiddenMatches: 0 }
}

export async function assertCssUrlsResolve(cssFile, packageRoot) {
  const css = await readFile(cssFile, 'utf8')
  const resolvedAssets = []
  for (const match of css.matchAll(cssUrlPattern)) {
    const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (
      reference === ''
      || reference.startsWith('#')
      || reference.startsWith('//')
      || /^[a-z][a-z\d+.-]*:/i.test(reference)
    ) continue

    const pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0])
    const resolved = path.resolve(path.dirname(cssFile), pathname)
    const relative = path.relative(packageRoot, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`local CSS URL ${JSON.stringify(reference)} escapes ${packageRoot} package root`)
    }
    try {
      const metadata = await stat(resolved)
      if (!metadata.isFile()) throw new Error('not a file')
    } catch {
      throw new Error(`missing local CSS asset ${JSON.stringify(reference)} resolved from ${cssFile}`)
    }
    resolvedAssets.push(resolved)
  }
  return [...new Set(resolvedAssets)].sort()
}

function decodePercentData(payload) {
  const bytes = []
  for (let index = 0; index < payload.length;) {
    if (payload[index] === '%') {
      const encodedByte = payload.slice(index + 1, index + 3)
      if (!/^[\da-f]{2}$/i.test(encodedByte)) {
        throw new Error(`invalid percent-encoded data at offset ${index}`)
      }
      bytes.push(Number.parseInt(encodedByte, 16))
      index += 3
      continue
    }
    const codePoint = payload.codePointAt(index)
    const character = String.fromCodePoint(codePoint)
    bytes.push(...Buffer.from(character))
    index += character.length
  }
  return Buffer.from(bytes)
}

async function embeddedCssFonts(cssFiles) {
  const embeddedFonts = []
  for (const cssFile of cssFiles) {
    const css = await readFile(cssFile, 'utf8')
    for (const match of css.matchAll(cssUrlPattern)) {
      const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim()
      if (!/^data:font\//i.test(reference)) continue
      const comma = reference.indexOf(',')
      if (comma === -1) continue
      const metadata = reference.slice(0, comma)
      const payload = reference.slice(comma + 1)
      embeddedFonts.push(
        /;base64(?:;|$)/i.test(metadata)
          ? Buffer.from(payload, 'base64')
          : decodePercentData(payload),
      )
    }
  }
  return embeddedFonts
}

export async function assertConsumerFontsMatch(
  installedFontFiles,
  emittedFontFiles,
  consumerCssFiles,
) {
  const installedFonts = await Promise.all(installedFontFiles.map((file) => readFile(file)))
  const consumerFonts = await Promise.all(emittedFontFiles.map((file) => readFile(file)))
  consumerFonts.push(...await embeddedCssFonts(consumerCssFiles))
  const missing = installedFonts.filter(
    (installed) => !consumerFonts.some((consumer) => consumer.equals(installed)),
  )
  if (missing.length > 0) {
    throw new Error(`consumer build is missing ${missing.length} of ${installedFonts.length} installed fonts`)
  }
  return installedFonts.length
}

export async function withTemporaryPackageRoot(run) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-pack-'))
  try {
    return await run({
      temporaryRoot,
      npmCache: path.join(temporaryRoot, 'npm-cache'),
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function npmInvocation(args, options = {}) {
  const npmExecpath = process.env.npm_execpath
  const command = npmExecpath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const commandArgs = npmExecpath ? [npmExecpath, ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: options.npmCache,
    },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
    }
    throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`)
  }
  return result.stdout ?? ''
}

async function packWorkspace(packageDirectory, tarballDirectory, npmCache) {
  const stdout = npmInvocation([
    'pack',
    '--json',
    '--pack-destination',
    tarballDirectory,
  ], { cwd: packageDirectory, capture: true, npmCache })
  const [report] = JSON.parse(stdout)
  if (!report?.filename || !Array.isArray(report.files)) {
    throw new Error(`npm pack returned an invalid report for ${packageDirectory}`)
  }
  return {
    filename: path.join(tarballDirectory, report.filename),
    files: report.files.map(({ path: filePath }) => filePath).sort(),
  }
}

function assertReactTarball(files) {
  const required = ['dist/cockpit.js', 'dist/cockpit.d.ts', 'dist/styles.css']
  for (const file of required) {
    if (!files.includes(file)) throw new Error(`React tarball is missing ${file}`)
  }
  if (!files.some((file) => /^dist\/assets\/.+\.js$/.test(file))) {
    throw new Error('React tarball is missing private JavaScript chunks under dist/assets')
  }
  if (!files.some((file) => /^dist\/assets\/.+\.(?:woff2?|ttf|otf)$/.test(file))) {
    throw new Error('React tarball is missing font assets under dist/assets')
  }
}

async function main() {
  await withTemporaryPackageRoot(async ({ temporaryRoot, npmCache }) => {
    const tarballDirectory = path.join(temporaryRoot, 'tarballs')
    const consumerDirectory = path.join(temporaryRoot, 'consumer')
    await mkdir(tarballDirectory, { recursive: true })
    await copyConsumerFixture(path.join(repoRoot, 'fixtures/cockpit-consumer'), consumerDirectory)

    const workspaces = [
      ['@open-mercato/cezar-contract', 'packages/contract'],
      ['@open-mercato/cezar-api-client', 'packages/api-client'],
      ['@open-mercato/cezar-react', 'packages/react'],
    ]
    for (const [workspace] of workspaces) {
      npmInvocation(['run', 'build', '-w', workspace], { npmCache })
    }

    const packed = []
    for (const [workspace, packageDirectory] of workspaces) {
      const tarball = await packWorkspace(
        path.join(repoRoot, packageDirectory),
        tarballDirectory,
        npmCache,
      )
      packed.push([workspace, tarball])
      console.log(`packed ${workspace}: ${tarball.files.length} files`)
    }
    const reactTarball = packed.find(([workspace]) => workspace === '@open-mercato/cezar-react')?.[1]
    if (!reactTarball) throw new Error('React tarball report was not produced')
    assertReactTarball(reactTarball.files)

    npmInvocation([
      'install',
      ...packed.map(([, tarball]) => tarball.filename),
      'react@19.2.7',
      'react-dom@19.2.7',
      '--ignore-scripts',
      '--no-save',
    ], { cwd: consumerDirectory, npmCache })

    const installedReact = path.join(
      consumerDirectory,
      'node_modules',
      '@open-mercato',
      'cezar-react',
    )
    const installedCss = path.join(installedReact, 'dist', 'styles.css')
    const installedAssets = await assertCssUrlsResolve(installedCss, installedReact)
    const installedFonts = installedAssets.filter((file) => /\.(?:woff2?|ttf|otf)$/.test(file))
    if (installedFonts.length === 0) throw new Error('installed React CSS resolves no font assets')

    npmInvocation(['run', 'typecheck'], { cwd: consumerDirectory, npmCache })
    npmInvocation(['run', 'build'], { cwd: consumerDirectory, npmCache })

    const consumerDist = path.join(consumerDirectory, 'dist')
    const consumerCssFiles = (await readdir(consumerDist, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
      .map((entry) => path.join(consumerDist, entry.name))
    const consumerAssets = []
    for (const cssFile of consumerCssFiles) {
      consumerAssets.push(...await assertCssUrlsResolve(cssFile, consumerDist))
    }
    const emittedConsumerFonts = consumerAssets.filter(
      (file) => /\.(?:woff2?|ttf|otf)$/.test(file),
    )
    const resolvedConsumerFonts = await assertConsumerFontsMatch(
      installedFonts,
      emittedConsumerFonts,
      consumerCssFiles,
    )

    const { filesScanned } = await scanInstalledRuntime(installedReact)
    console.log(`cold cockpit consumer ok — 3 tarballs installed, 1 typecheck, 1 Vite build, ${resolvedConsumerFonts} fonts resolved, ${filesScanned} runtime/declaration files scanned`)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
