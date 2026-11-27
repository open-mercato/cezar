#!/usr/bin/env node
// Renders the package-manager manifests for one published desktop release (spec
// 2026-09-25-desktop-distribution.md, #1763). Pure text in, files out: the workflow downloads the
// release's `.sha256` assets, calls this, and pushes the result. Homebrew has its own bumper
// (bump-homebrew-cask.mjs).
//   node render-channels.mjs winget <version> <setup.exe sha256> <outdir> [<YYYY-MM-DD>]
//   node render-channels.mjs aur    <version> <.deb sha256> <outdir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA = /^[0-9a-f]{64}$/
const VERSION = /^\d+\.\d+\.\d+$/
const REPO = 'open-mercato/cezar'
export const WINGET_ID = 'OpenMercato.Cezar'
const MANIFEST_VERSION = '1.6.0'
const here = dirname(fileURLToPath(import.meta.url))

function check(version, sha) {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`)
  if (!SHA.test(sha)) throw new Error(`not a sha256: ${sha}`)
}

const header = (type, schema) =>
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${schema}.${MANIFEST_VERSION}.schema.json\n` +
  `PackageIdentifier: ${WINGET_ID}\nPackageVersion: %V\n`

/** The three winget-pkgs files, keyed by file name. Silent switch /S is NSIS (Tauri's installer). */
export function renderWinget(version, sha256, releaseDate) {
  check(version, sha256)
  const url = `https://github.com/${REPO}/releases/download/desktop-v${version}/cezar-windows-x86_64-setup.exe`
  const files = {
    [`${WINGET_ID}.yaml`]:
      header('version', 'version') + `DefaultLocale: en-US\nManifestType: version\nManifestVersion: ${MANIFEST_VERSION}\n`,
    [`${WINGET_ID}.installer.yaml`]:
      header('installer', 'installer') +
      `MinimumOSVersion: 10.0.17763.0\nInstallerType: nullsoft\nScope: user\nInstallModes:\n  - interactive\n  - silent\n  - silentWithProgress\n` +
      `InstallerSwitches:\n  Silent: /S\n  SilentWithProgress: /S\nUpgradeBehavior: install\n` +
      (releaseDate ? `ReleaseDate: ${releaseDate}\n` : '') +
      `Installers:\n  - Architecture: x64\n    InstallerUrl: ${url}\n    InstallerSha256: ${sha256.toUpperCase()}\n` +
      `ManifestType: installer\nManifestVersion: ${MANIFEST_VERSION}\n`,
    [`${WINGET_ID}.locale.en-US.yaml`]:
      header('defaultLocale', 'defaultLocale') +
      `PackageLocale: en-US\nPublisher: Open Mercato\nPublisherUrl: https://github.com/open-mercato\n` +
      `PackageName: Cezar\nPackageUrl: https://github.com/${REPO}\nLicense: MIT\n` +
      `LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE\n` +
      `ShortDescription: Local cockpit for AI coding agents\nTags:\n  - ai\n  - coding-agents\n  - developer-tools\n` +
      `ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/desktop-v%V\nManifestType: defaultLocale\nManifestVersion: ${MANIFEST_VERSION}\n`,
  }
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, text.replaceAll('%V', version)]))
}

/** winget-pkgs layout: manifests/<first letter>/<Publisher>/<Name>/<version>/ */
export const wingetDir = version => `manifests/${WINGET_ID[0].toLowerCase()}/${WINGET_ID.split('.').join('/')}/${version}`

function replaceOnce(text, pattern, replacement, what) {
  if ((text.match(new RegExp(pattern.source, pattern.flags + 'g')) ?? []).length !== 1) throw new Error(`expected exactly one ${what} in the PKGBUILD`)
  return text.replace(pattern, replacement)
}

/** AUR PKGBUILD + .SRCINFO. Derived from arch/PKGBUILD so the two packages never drift: only the
 *  version and the source (the release's .deb, pinned by sha256) change. */
export function renderAur(version, debSha256, template = readFileSync(join(here, '../arch/PKGBUILD'), 'utf8')) {
  check(version, debSha256)
  const url = `https://github.com/${REPO}/releases/download/desktop-v${version}/cezar-linux-x86_64.deb`
  const file = `cezar-${version}.deb`
  let pkgbuild = replaceOnce(template, /@VERSION@/, version, '@VERSION@')
  pkgbuild = replaceOnce(pkgbuild, /^source=\('cezar\.deb'\)$/m, `source=("${file}::${url}")`, 'source')
  pkgbuild = replaceOnce(pkgbuild, /^noextract=\('cezar\.deb'\)$/m, `noextract=("${file}")`, 'noextract')
  pkgbuild = replaceOnce(pkgbuild, /^sha256sums=\('SKIP'\)$/m, `sha256sums=('${debSha256}')`, 'sha256sums')
  pkgbuild = pkgbuild.replaceAll('$srcdir/cezar.deb', `$srcdir/${file}`)
  const field = name => pkgbuild.match(new RegExp(`^${name}=\\(?['"]?([^'")\\n]*)`, 'm'))?.[1]
  const list = name => [...(pkgbuild.match(new RegExp(`^${name}=\\(([\\s\\S]*?)\\)$`, 'm'))?.[1] ?? '').matchAll(/'([^']*)'/g)].map(m => m[1])
  const srcinfo = [
    `pkgbase = cezar-desktop-bin`,
    `\tpkgdesc = ${field('pkgdesc')}`,
    `\tpkgver = ${version}`,
    `\tpkgrel = ${field('pkgrel')}`,
    `\turl = ${field('url')}`,
    `\tarch = x86_64`,
    `\tlicense = ${field('license')}`,
    ...list('optdepends').map(d => `\toptdepends = ${d}`),
    ...list('depends').map(d => `\tdepends = ${d}`),
    `\tprovides = cezar-desktop`,
    `\tconflicts = cezar-desktop`,
    `\toptions = !strip`,
    `\toptions = !debug`,
    `\tnoextract = ${file}`,
    `\tsource = ${file}::${url}`,
    `\tsha256sums = ${debSha256}`,
    ``,
    `pkgname = cezar-desktop-bin`,
    ``,
  ].join('\n')
  return { PKGBUILD: pkgbuild, '.SRCINFO': srcinfo }
}

function write(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [channel, version, sha, out, date] = process.argv.slice(2)
  if (channel === 'winget') write(out, renderWinget(version, sha, date))
  else if (channel === 'aur') write(out, renderAur(version, sha))
  else {
    console.error('usage: render-channels.mjs winget|aur <version> <sha256> <outdir> [<date>]')
    process.exit(2)
  }
}
