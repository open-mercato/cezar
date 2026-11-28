#!/usr/bin/env node
// The fail-closed decisions of desktop-release.yml, in one place a test can run (#2547).
//   node desktop-release-gates.mjs signpath-fallback <policy slug>        → true | false
//   node desktop-release-gates.mjs windows-state <signpath outcome> <authenticode status>
//   node desktop-release-gates.mjs macos-state <has apple> <codesign -dv file> <spctl file>
//   node desktop-release-gates.mjs publish-trust <windows> <macos aarch64> <macos x86_64>
//   node desktop-release-gates.mjs rolling-title <version>
//   node desktop-release-gates.mjs rolling-decision <version> <current desktop-latest title>
// Any unexpected input fails the command (exit 2) rather than answering "trusted" or "update".
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { isOlderVersion } from './bump-homebrew-cask.mjs'

// Exact and case-sensitive: GitHub's `==` ignores case, so this decision is never made there.
export const TEST_SIGNING_POLICY = 'test-signing'

export function signpathFallback(policy) {
  return policy === TEST_SIGNING_POLICY
}

// Trust is the signature Windows reports, never the policy slug.
export function windowsState(signpathOutcome, authenticodeStatus) {
  if (signpathOutcome !== 'success') return 'unsigned'
  return authenticodeStatus === 'Valid' ? 'trusted' : 'test-signed'
}

// Positive evidence only: a Developer ID Application authority AND Gatekeeper's notarized verdict.
export function macosState(hasApple, codesignInfo, gatekeeperInfo) {
  const developerId = /^Authority=Developer ID Application: /m.test(codesignInfo)
  const notarized = /^source=Notarized Developer ID$/m.test(gatekeeperInfo) && /: accepted$/m.test(gatekeeperInfo)
  return hasApple === 'true' && developerId && notarized ? 'developer-id' : 'ad-hoc'
}

export function publishTrusted(windows, macosAarch64, macosX86_64) {
  return windows === 'trusted' && macosAarch64 === 'developer-id' && macosX86_64 === 'developer-id'
}

export function rollingTitle(version) {
  return `cezar desktop (latest: v${version})`
}

export function rollingVersion(title) {
  return title.match(/^cezar desktop \(latest: v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\)$/)?.[1]
}

// `skip` when the rolling release already points at a newer version. A title this script did
// not write throws: the guard must not switch itself off.
export function rollingDecision(version, currentTitle) {
  const current = rollingVersion(currentTitle)
  if (!current) throw new Error(`cannot read the version desktop-latest points at from its title: ${JSON.stringify(currentTitle)}`)
  return isOlderVersion(version, current) ? 'skip' : 'update'
}

const COMMANDS = {
  'signpath-fallback': ([policy = '']) => String(signpathFallback(policy)),
  'windows-state': ([outcome = '', status = '']) => windowsState(outcome, status),
  'macos-state': ([hasApple = '', codesignFile, gatekeeperFile]) =>
    macosState(hasApple, readFileSync(codesignFile, 'utf8'), readFileSync(gatekeeperFile, 'utf8')),
  'publish-trust': ([windows, arm, intel]) => String(publishTrusted(windows, arm, intel)),
  'rolling-title': ([version = '']) => rollingTitle(version),
  'rolling-decision': ([version = '', title = '']) => rollingDecision(version, title),
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (!COMMANDS[command]) throw new Error(`unknown command: ${command}`)
    console.log(COMMANDS[command](args))
  } catch (error) {
    console.error(`::error::${error.message}`)
    process.exit(2)
  }
}
