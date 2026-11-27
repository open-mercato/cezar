import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import {
  macosState,
  publishTrusted,
  rollingDecision,
  rollingTitle,
  rollingVersion,
  signpathFallback,
  windowsState,
} from './desktop-release-gates.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const workflowPath = path.join(root, '.github/workflows/desktop-release.yml')
const gatesPath = path.join(root, 'packages/desktop/scripts/desktop-release-gates.mjs')

function gate(...args) {
  return spawnSync(process.execPath, [gatesPath, ...args], { encoding: 'utf8' })
}

const DEVELOPER_ID_CODESIGN = [
  'Executable=/Applications/Cezar.app/Contents/MacOS/cezar',
  'Identifier=com.open-mercato.cezar',
  'Format=app bundle with Mach-O thin (arm64)',
  'Authority=Developer ID Application: Open Mercato (ABCDE12345)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=ABCDE12345',
  'Sealed Resources version=2 rules=13 files=40',
].join('\n')
const ADHOC_CODESIGN = [
  'Executable=/Applications/Cezar.app/Contents/MacOS/cezar',
  'Signature=adhoc',
  'TeamIdentifier=not set',
].join('\n')
const NOTARIZED = 'Cezar.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Open Mercato (ABCDE12345)'
const SIGNED_NOT_NOTARIZED = 'Cezar.app: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Open Mercato (ABCDE12345)'

function workflow() {
  return parse(readFileSync(workflowPath, 'utf8'))
}

function step(steps, name) {
  const found = steps.find(item => item.name === name)
  if (!found) throw new Error(`missing workflow step: ${name}`)
  return found
}

describe('desktop release workflow signing path', () => {
  it('keeps SignPath disabled until credentials exist and uploads only in non-dry runs', () => {
    const doc = workflow()
    const buildSteps = doc.jobs.build.steps
    const signing = step(buildSteps, 'Signing status')
    const signPathStep = step(buildSteps, 'Sign the installer with SignPath')
    const replaceStep = step(buildSteps, 'Put the signed installer in place')

    expect(signing.env.HAS_SIGNPATH).toContain('secrets.SIGNPATH_API_TOKEN')
    expect(signing.env.HAS_SIGNPATH).toContain('secrets.SIGNPATH_ORGANIZATION_ID')
    expect(signPathStep.if).toBe("runner.os == 'Windows' && steps.signing.outputs.signpath == 'true'")
    expect(signPathStep.with['github-artifact-id']).toBe('${{ steps.unsigned.outputs.artifact-id }}')
    expect(replaceStep.env.DRY_RUN).toBe('${{ inputs.dry_run }}')
    expect(replaceStep.run).toContain('if [ "$DRY_RUN" != "true" ]; then')
    expect(doc.jobs.prepare.steps.some(item => item.name === 'Create the draft release' && item.if === '${{ !inputs.dry_run }}')).toBe(true)
    expect(doc.jobs.publish.if).toBe('${{ !inputs.dry_run }}')
  })

  it('rejects a missing or invalid signed installer before upload and re-signs for the updater', () => {
    const replaceRun = step(workflow().jobs.build.steps, 'Put the signed installer in place').run

    const missingCheck = replaceRun.indexOf('test -f "signed/$NAME"')
    const copySigned = replaceRun.indexOf('cp "signed/$NAME" "$INSTALLER"')
    const authenticode = replaceRun.indexOf('$signature = Get-AuthenticodeSignature')
    const upload = replaceRun.indexOf('gh release upload "$TAG" "$INSTALLER" --clobber')

    expect(missingCheck).toBeGreaterThanOrEqual(0)
    expect(copySigned).toBeGreaterThan(missingCheck)
    expect(authenticode).toBeGreaterThan(copySigned)
    expect(replaceRun).toContain('$null -eq $signature.SignerCertificate')
    // The fallback decision comes from the gate module, never a case-insensitive slug comparison.
    expect(replaceRun).toContain("$env:SIGNPATH_FALLBACK -ne 'true' -and $signature.Status -ne 'Valid'")
    expect(replaceRun).not.toContain("'test-signing'")
    // The status is written before any exit, and published as the step's output.
    expect(replaceRun.indexOf('Set-Content -Path authenticode-status.txt')).toBeLessThan(replaceRun.indexOf('$null -eq $signature.SignerCertificate'))
    expect(replaceRun).toContain('echo "authenticode=$(cat authenticode-status.txt)" >> "$GITHUB_OUTPUT"')
    expect(replaceRun).toContain('$signature.Status -ne \'Valid\'')
    expect(replaceRun).toContain('The installer is signed but not trusted by Windows under policy')
    expect(replaceRun).toContain('rm -f "$INSTALLER.sig"')
    expect(replaceRun).toContain('npx tauri signer sign "$INSTALLER"')
    expect(upload).toBeGreaterThan(authenticode)
  })

  it('uploads the re-made updater signature after re-signing the signed installer', () => {
    const replaceRun = step(workflow().jobs.build.steps, 'Put the signed installer in place').run

    // A stale `.sig` next to the SignPath-signed installer fails every Windows auto-update.
    const removeSig = replaceRun.indexOf('rm -f "$INSTALLER.sig"')
    const resign = replaceRun.indexOf('npx tauri signer sign "$INSTALLER"')
    const sigUpload = replaceRun.indexOf('gh release upload "$TAG" "$INSTALLER.sig" --clobber')

    expect(removeSig).toBeGreaterThanOrEqual(0)
    expect(resign).toBeGreaterThan(removeSig)
    expect(sigUpload).toBeGreaterThan(resign)
  })

  it('falls back to the unsigned installer only under the exact test-signing policy', () => {
    const buildSteps = workflow().jobs.build.steps
    const signPathStep = step(buildSteps, 'Sign the installer with SignPath')
    const fallback = step(buildSteps, 'Report the unsigned Windows fallback')
    const replaceStep = step(buildSteps, 'Put the signed installer in place')

    // v2's deprecated connector failed 2 of 3 desktop-v0.1.12 attempts ("Invalid URL for GitHub API").
    expect(signPathStep.uses).toMatch(/^signpath\/github-action-submit-signing-request@[0-9a-f]{40}$/)
    expect(readFileSync(workflowPath, 'utf8')).toMatch(/submit-signing-request@[0-9a-f]{40} # v3/)
    expect(signPathStep.with['connector-url']).toBeUndefined()
    // Decided by the gate module, case-sensitively, before the request: GitHub's `==` ignores case.
    const policy = step(buildSteps, 'Decide the SignPath fallback')
    expect(buildSteps.indexOf(policy)).toBeLessThan(buildSteps.indexOf(signPathStep))
    expect(policy.id).toBe('policy')
    expect(policy.run).toContain('node scripts/desktop-release-gates.mjs signpath-fallback "$SIGNPATH_SIGNING_POLICY"')
    expect(signPathStep['continue-on-error']).toBe("${{ steps.policy.outputs.fallback == 'true' }}")
    expect(replaceStep.env.SIGNPATH_FALLBACK).toBe('${{ steps.policy.outputs.fallback }}')
    expect(readFileSync(workflowPath, 'utf8')).not.toMatch(/==\s*'test-signing'/)
    expect(fallback.if).toContain("steps.signpath.outcome == 'failure'")
    expect(fallback.run).toContain('GITHUB_STEP_SUMMARY')
    expect(replaceStep.if).toContain("steps.signpath.outcome == 'success'")
  })

  it('writes desktop-latest.json once, in the publish job, never from the parallel build legs', () => {
    const doc = workflow()
    const tauri = step(doc.jobs.build.steps, 'Build and upload with tauri-action')
    const checkout = step(doc.jobs.publish.steps, 'Check out repository')
    const publishRun = step(doc.jobs.publish.steps, 'Write the updater manifest and publish').run

    // Every leg read-merge-replaced the same latest.json: desktop-v0.1.12's Intel leg 404'd.
    expect(tauri.with.includeUpdaterJson).toBe(false)
    expect(doc.jobs.publish.steps.indexOf(checkout)).toBe(0)
    expect(checkout.with['sparse-checkout']).toContain('packages/desktop/scripts')
    expect(publishRun).toContain("gh release download \"$TAG\" --repo \"$REPO\" --pattern '*.sig' --dir sigs")
    expect(publishRun).toContain('node packages/desktop/scripts/build-updater-manifest.mjs desktop-latest.json sigs "$VERSION"')
    expect(publishRun).toContain('gh release upload "$TAG" desktop-latest.json --clobber --repo "$REPO"')
    expect(publishRun.indexOf('delete-asset "$TAG" latest.json')).toBeLessThan(publishRun.indexOf('--draft=false'))
  })

  it('bumps the Homebrew tap only after a real publish, with a tap-scoped release-app token, and skips with a warning without one', () => {
    const doc = workflow()
    const job = doc.jobs['homebrew-tap']
    const mint = step(job.steps, 'Mint the tap token')
    const status = step(job.steps, 'Homebrew tap status')
    const bump = step(job.steps, 'Bump Casks/cezar.rb')
    const releasePin = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8').match(/uses: (actions\/create-github-app-token@\S+)/)[1]

    expect(job.needs).toEqual(['prepare', 'publish'])
    expect(job.if).toBe("${{ !inputs.dry_run && needs.publish.outputs.trusted == 'true' }}")
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(mint.uses).toBe(releasePin)
    expect(mint['continue-on-error']).toBe(true)
    expect(mint.with).toEqual({
      'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
      owner: 'open-mercato',
      repositories: 'homebrew-tap',
      'permission-contents': 'write',
    })
    expect(status.env.MINTED).toBe("${{ steps.app-token.outputs.token != '' }}")
    expect(status.run).toContain('install the release app on open-mercato/homebrew-tap')
    for (const s of job.steps.slice(2)) expect(s.if).toBe("steps.tap.outputs.token == 'true'")
    expect(bump.env.TAP_TOKEN).toBe('${{ steps.app-token.outputs.token }}')
    expect(readFileSync(workflowPath, 'utf8')).not.toContain('HOMEBREW_TAP_TOKEN')
    expect(bump.run).toContain('--branch main')
    expect(bump.run).toContain('open-mercato/homebrew-tap.git')
    expect(bump.run).toContain('node packages/desktop/scripts/bump-homebrew-cask.mjs tap/Casks/cezar.rb "$VERSION" "$ARM" "$INTEL" $BINARIES')
    expect(bump.run).toContain('[ -x packages/desktop/src-tauri/resources/bin/cez ] && BINARIES="--binaries"')
    expect(step(job.steps, 'Check out repository').with['sparse-checkout']).toContain('packages/desktop/src-tauri/resources/bin')
    expect(bump.run).toContain('git push origin HEAD:main')
  })

  it('records each leg\'s signing outcome under its own job output', () => {
    const build = workflow().jobs.build
    const trust = step(build.steps, 'Record the signing outcome')

    expect(build.outputs).toEqual({
      windows: '${{ steps.trust.outputs.windows }}',
      macos_aarch64: '${{ steps.trust.outputs.macos_aarch64 }}',
      macos_x86_64: '${{ steps.trust.outputs.macos_x86_64 }}',
    })
    expect(trust.id).toBe('trust')
    expect(trust.env.KEY).toContain("'windows'")
    expect(trust.env.KEY).toContain("'macos_aarch64'")
    expect(trust.env.KEY).toContain("'macos_x86_64'")
    expect(trust.env.SIGNPATH_OUTCOME).toBe('${{ steps.signpath.outcome }}')
    expect(trust.env.AUTHENTICODE).toBe('${{ steps.placed.outputs.authenticode }}')
    expect(trust.env.SIGNPATH_SIGNING_POLICY).toBeUndefined()
    expect(step(build.steps, 'Put the signed installer in place').id).toBe('placed')
    expect(trust.run).toContain('STATE=$(node scripts/desktop-release-gates.mjs windows-state "$SIGNPATH_OUTCOME" "$AUTHENTICODE")')
    // codesign and spctl are captured to files first: no pipe into `grep -q` under pipefail.
    expect(trust.run).toContain('codesign -dv --verbose=2 "${apps[0]}" > codesign-info.txt 2>&1')
    expect(trust.run).toContain('spctl -a -vv -t exec "${apps[0]}" > gatekeeper-info.txt 2>&1 || true')
    expect(trust.run).toContain('STATE=$(node scripts/desktop-release-gates.mjs macos-state "$HAS_APPLE" codesign-info.txt gatekeeper-info.txt)')
    expect(trust.run).not.toMatch(/\|\s*grep -q/)
    // After every check that can fail the leg.
    expect(build.steps.indexOf(trust)).toBeGreaterThan(build.steps.indexOf(step(build.steps, 'Put the signed installer in place')))
    expect(build.steps.indexOf(trust)).toBeGreaterThan(build.steps.indexOf(step(build.steps, "Verify the macOS bundle's signature")))
  })

  it('refuses to publish an untrusted build, and keeps an allowed one off every public surface', () => {
    const doc = workflow()
    const publish = doc.jobs.publish
    const trust = step(publish.steps, 'Check how every installer was signed')
    const release = step(publish.steps, 'Write the updater manifest and publish')
    const rolling = step(publish.steps, 'Refresh the rolling desktop-latest release')

    expect(doc.on.workflow_dispatch.inputs.allow_untrusted).toMatchObject({ type: 'boolean', default: false })
    expect(publish.outputs.trusted).toBe('${{ steps.trust.outputs.trusted }}')
    expect(publish.steps.indexOf(trust)).toBe(1)
    expect(trust.env).toMatchObject({
      WINDOWS: '${{ needs.build.outputs.windows }}',
      MACOS_AARCH64: '${{ needs.build.outputs.macos_aarch64 }}',
      MACOS_X86_64: '${{ needs.build.outputs.macos_x86_64 }}',
      ALLOW_UNTRUSTED: '${{ inputs.allow_untrusted }}',
    })
    expect(trust.run).toContain('TRUSTED=$(node packages/desktop/scripts/desktop-release-gates.mjs publish-trust "$WINDOWS" "$MACOS_AARCH64" "$MACOS_X86_64")')
    expect(trust.run).toMatch(/else\n\s*echo "::error::refusing to publish[^\n]*\n[^\n]*\n\s*exit 1/)
    expect(trust.run).toContain('GITHUB_STEP_SUMMARY')
    expect(trust.run).toContain('| Windows | ${WINDOWS:-unknown} |')

    // An allowed untrusted build is a prerelease with no manifest, published before the manifest is written.
    expect(release.env.TRUSTED).toBe('${{ steps.trust.outputs.trusted }}')
    const untrustedBranch = release.run.indexOf('if [ "$TRUSTED" != "true" ]; then')
    expect(untrustedBranch).toBeGreaterThanOrEqual(0)
    expect(release.run).toContain('--draft=false --prerelease --latest=false')
    expect(untrustedBranch).toBeLessThan(release.run.indexOf('build-updater-manifest.mjs'))
    expect(untrustedBranch).toBeLessThan(release.run.indexOf('gh release upload "$TAG" desktop-latest.json'))
    // The untrusted branch ENDS the step: without this exit a prerelease would still get the manifest.
    const untrusted = release.run.slice(untrustedBranch, release.run.indexOf('build-updater-manifest.mjs'))
    expect(untrusted).toMatch(/--prerelease[^\n]*\n[^\n]*\n\s*exit 0\n\s*fi/)
    expect(rolling.if).toBe("steps.trust.outputs.trusted == 'true'")
  })

  it('never re-releases a published version in place', () => {
    const create = step(workflow().jobs.prepare.steps, 'Create the draft release').run

    expect(create).toContain('gh release view "$TAG" --json isDraft -q .isDraft')
    const refuse = create.indexOf('if [ "$IS_DRAFT" = "false" ]; then')
    expect(refuse).toBeGreaterThanOrEqual(0)
    expect(create.slice(refuse, create.indexOf('elif'))).toContain('exit 1')
    expect(refuse).toBeLessThan(create.indexOf('gh release create'))
  })

  it('starts a manual run only from main or a desktop tag, and keeps signing secrets in the desktop-release environment', () => {
    const doc = workflow()
    const guard = doc.jobs.prepare.steps[0]

    expect(guard.name).toBe('Check the ref a manual run starts from')
    expect(guard.if).toBe("github.event_name == 'workflow_dispatch'")
    expect(guard.run).toContain('refs/heads/main|refs/tags/desktop-v*)')
    expect(guard.run).toMatch(/\*\) echo "::error::[^\n]*; exit 1 ;;/)
    // Every job that reads a signing or release-app secret, and only those.
    const source = readFileSync(workflowPath, 'utf8')
    for (const [id, job] of Object.entries(doc.jobs)) {
      const usesSecrets = /secrets\.(?!GITHUB_TOKEN)/.test(JSON.stringify(job))
      expect([id, job.environment]).toEqual([id, usesSecrets ? 'desktop-release' : undefined])
    }
    expect(source).toContain('environment: desktop-release')
  })

  it('never moves desktop-latest back to an older version, and fails closed on a title it cannot read', () => {
    const rolling = step(workflow().jobs.publish.steps, 'Refresh the rolling desktop-latest release').run

    const read = rolling.indexOf('if CURRENT_TITLE=$(gh release view desktop-latest --repo "$REPO" --json name -q .name); then')
    const decide = rolling.indexOf('DECISION=$(node "$GATES" rolling-decision "$VERSION" "$CURRENT_TITLE")')
    expect(rolling).toContain('GATES=packages/desktop/scripts/desktop-release-gates.mjs')
    expect(rolling).toContain('TITLE=$(node "$GATES" rolling-title "$VERSION")')
    expect(read).toBeGreaterThanOrEqual(0)
    expect(decide).toBeGreaterThan(read)
    // Anything but an explicit `update` stops the refresh; a failing gate fails the step under `bash -e`.
    expect(rolling.slice(decide, rolling.indexOf('mkdir rolling'))).toMatch(/if \[ "\$DECISION" != "update" \]; then[\s\S]*exit 0/)
    expect(decide).toBeLessThan(rolling.indexOf('gh release upload desktop-latest'))
    expect(decide).toBeLessThan(rolling.indexOf('gh release edit desktop-latest'))
    // The title the guard reads is the one the refresh writes, from the same helper.
    expect(rolling.match(/--title "\$TITLE"/g)).toHaveLength(2)
    expect(rolling).not.toContain('(latest: v')
    expect(rolling).not.toContain('2>/dev/null | sed')
  })

  it('reports macOS signing under the same condition the build signs under', () => {
    const doc = workflow()
    const buildCondition = step(doc.jobs.build.steps, 'Signing status').env.HAS_APPLE
    const summary = step(doc.jobs.publish.steps, 'Write workflow summary')

    expect(buildCondition).toBe("${{ secrets.APPLE_CERTIFICATE != '' && secrets.APPLE_ID != '' && secrets.APPLE_PASSWORD != '' }}")
    expect(summary.env.HAS_APPLE).toBe(buildCondition)
    expect(summary.run).toContain('ad-hoc signed, not notarized')
  })
})

describe('desktop release gates (run, not matched)', () => {
  it('falls back from SignPath only under the exact, case-sensitive test-signing slug', () => {
    expect(signpathFallback('test-signing')).toBe(true)
    for (const slug of ['Test-Signing', 'TEST-SIGNING', 'test-signing ', 'release-signing', 'release', '']) {
      expect([slug, signpathFallback(slug)]).toEqual([slug, false])
    }
  })

  it('trusts a Windows installer only when SignPath succeeded and Authenticode says Valid', () => {
    expect(windowsState('success', 'Valid')).toBe('trusted')
    // A test certificate, whatever the slug was, is never trusted.
    for (const status of ['UnknownError', 'NotTrusted', 'HashMismatch', 'NotSigned', 'valid', '']) {
      expect([status, windowsState('success', status)]).toEqual([status, 'test-signed'])
    }
    for (const outcome of ['failure', 'skipped', 'cancelled', '']) {
      expect(windowsState(outcome, 'Valid')).toBe('unsigned')
    }
  })

  it('records developer-id only for a Developer ID authority that Gatekeeper reports notarized', () => {
    expect(macosState('true', DEVELOPER_ID_CODESIGN, NOTARIZED)).toBe('developer-id')
    expect(macosState('true', ADHOC_CODESIGN, NOTARIZED)).toBe('ad-hoc')
    expect(macosState('true', DEVELOPER_ID_CODESIGN, SIGNED_NOT_NOTARIZED)).toBe('ad-hoc')
    expect(macosState('true', DEVELOPER_ID_CODESIGN, '')).toBe('ad-hoc')
    expect(macosState('false', DEVELOPER_ID_CODESIGN, NOTARIZED)).toBe('ad-hoc')
    expect(macosState('true', 'Authority=Apple Development: someone (XYZ)', NOTARIZED)).toBe('ad-hoc')
    expect(macosState('true', '', '')).toBe('ad-hoc')
  })

  it('publishes as trusted only when every leg is, and treats a missing leg as untrusted', () => {
    expect(publishTrusted('trusted', 'developer-id', 'developer-id')).toBe(true)
    expect(publishTrusted('test-signed', 'developer-id', 'developer-id')).toBe(false)
    expect(publishTrusted('unsigned', 'developer-id', 'developer-id')).toBe(false)
    expect(publishTrusted('trusted', 'ad-hoc', 'developer-id')).toBe(false)
    expect(publishTrusted('trusted', 'developer-id', 'ad-hoc')).toBe(false)
    expect(publishTrusted('trusted', 'developer-id', '')).toBe(false)
    expect(publishTrusted('', '', '')).toBe(false)
  })

  it('reads back the title it writes, refuses downgrades, and throws on a title it did not write', () => {
    expect(rollingTitle('0.1.17')).toBe('cezar desktop (latest: v0.1.17)')
    for (const version of ['0.1.17', '1.2.3', '0.2.0-rc.1']) expect(rollingVersion(rollingTitle(version))).toBe(version)
    expect(rollingDecision('0.1.16', rollingTitle('0.1.17'))).toBe('skip')
    expect(rollingDecision('0.1.17', rollingTitle('0.1.17'))).toBe('update')
    expect(rollingDecision('0.1.18', rollingTitle('0.1.17'))).toBe('update')
    for (const title of ['', 'cezar desktop', 'cezar desktop (latest: 0.1.17)', 'Cezar Desktop (latest: v0.1.17)']) {
      expect(() => rollingDecision('0.1.18', title)).toThrow(/cannot read the version/)
    }
  })

  it('runs as the workflow calls it, and fails the step on bad input instead of answering', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'desktop-gates-'))
    try {
      writeFileSync(path.join(dir, 'codesign.txt'), DEVELOPER_ID_CODESIGN)
      writeFileSync(path.join(dir, 'adhoc.txt'), ADHOC_CODESIGN)
      writeFileSync(path.join(dir, 'gatekeeper.txt'), NOTARIZED)
      const run = (...args) => execFileSync(process.execPath, [gatesPath, ...args], { encoding: 'utf8' }).trim()

      expect(run('signpath-fallback', 'test-signing')).toBe('true')
      expect(run('signpath-fallback', 'Test-Signing')).toBe('false')
      expect(run('windows-state', 'success', 'Valid')).toBe('trusted')
      expect(run('windows-state', 'success', 'UnknownError')).toBe('test-signed')
      expect(run('windows-state', '', '')).toBe('unsigned')
      expect(run('macos-state', 'true', path.join(dir, 'codesign.txt'), path.join(dir, 'gatekeeper.txt'))).toBe('developer-id')
      expect(run('macos-state', 'true', path.join(dir, 'adhoc.txt'), path.join(dir, 'gatekeeper.txt'))).toBe('ad-hoc')
      expect(run('publish-trust', 'trusted', 'developer-id', 'developer-id')).toBe('true')
      expect(run('publish-trust', 'test-signed', 'developer-id', 'developer-id')).toBe('false')
      expect(run('rolling-decision', '0.1.16', 'cezar desktop (latest: v0.1.17)')).toBe('skip')

      const unreadable = gate('rolling-decision', '0.1.18', 'something else')
      expect(unreadable.status).toBe(2)
      expect(unreadable.stdout).toBe('')
      expect(gate('macos-state', 'true', path.join(dir, 'missing.txt'), path.join(dir, 'gatekeeper.txt')).status).toBe(2)
      expect(gate('no-such-command').status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
