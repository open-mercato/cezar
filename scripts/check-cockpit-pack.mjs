#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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

function npmInvocation(args, options = {}) {
  const npmExecpath = process.env.npm_execpath
  const command = npmExecpath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const commandArgs = npmExecpath ? [npmExecpath, ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: path.join(tmpdir(), 'cezar-npm-cache'),
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

async function packWorkspace(packageDirectory, tarballDirectory) {
  const stdout = npmInvocation([
    'pack',
    '--json',
    '--pack-destination',
    tarballDirectory,
  ], { cwd: packageDirectory, capture: true })
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
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'cezar-cockpit-pack-'))
  const tarballDirectory = path.join(temporaryRoot, 'tarballs')
  const consumerDirectory = path.join(temporaryRoot, 'consumer')
  try {
    await mkdir(tarballDirectory, { recursive: true })
    await copyConsumerFixture(path.join(repoRoot, 'fixtures/cockpit-consumer'), consumerDirectory)

    const workspaces = [
      ['@open-mercato/cezar-contract', 'packages/contract'],
      ['@open-mercato/cezar-api-client', 'packages/api-client'],
      ['@open-mercato/cezar-react', 'packages/react'],
    ]
    for (const [workspace] of workspaces) npmInvocation(['run', 'build', '-w', workspace])

    const packed = []
    for (const [workspace, packageDirectory] of workspaces) {
      const tarball = await packWorkspace(path.join(repoRoot, packageDirectory), tarballDirectory)
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
    ], { cwd: consumerDirectory })
    npmInvocation(['run', 'typecheck'], { cwd: consumerDirectory })
    npmInvocation(['run', 'build'], { cwd: consumerDirectory })

    const installedReact = path.join(
      consumerDirectory,
      'node_modules',
      '@open-mercato',
      'cezar-react',
    )
    const { filesScanned } = await scanInstalledRuntime(installedReact)
    console.log(`cold cockpit consumer ok — 3 tarballs installed, 1 typecheck, 1 Vite build, ${filesScanned} runtime/declaration files scanned`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
