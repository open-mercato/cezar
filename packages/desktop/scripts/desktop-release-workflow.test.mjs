import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const workflowPath = path.join(root, '.github/workflows/desktop-release.yml')

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
    expect(replaceRun).toContain("$env:SIGNPATH_SIGNING_POLICY -ne 'test-signing' -and $signature.Status -ne 'Valid'")
    expect(replaceRun).not.toContain("-eq 'release-signing'")
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
    // Any other slug — unknown, mistyped or unset — fails closed.
    expect(signPathStep['continue-on-error']).toBe("${{ vars.SIGNPATH_SIGNING_POLICY_SLUG == 'test-signing' }}")
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
    expect(trust.run).toContain('STATE=trusted')
    expect(trust.run).toContain('STATE=test-signed')
    expect(trust.run).toContain('STATE=unsigned')
    expect(trust.run).toContain('STATE=developer-id')
    expect(trust.run).toContain('STATE=ad-hoc')
    expect(trust.run).toContain("grep -q 'Signature=adhoc'")
    // Only a non-test policy that succeeded is trusted; the Authenticode check already required Valid.
    expect(trust.run.indexOf('STATE=unsigned')).toBeLessThan(trust.run.indexOf('STATE=test-signed'))
    expect(trust.run.indexOf('STATE=test-signed')).toBeLessThan(trust.run.indexOf('STATE=trusted'))
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
    // Fail closed: any missing or weaker outcome makes the build untrusted.
    expect(trust.run).toContain('[ "$WINDOWS" = "trusted" ] || TRUSTED=false')
    expect(trust.run).toContain('[ "$MACOS_AARCH64" = "developer-id" ] || TRUSTED=false')
    expect(trust.run).toContain('[ "$MACOS_X86_64" = "developer-id" ] || TRUSTED=false')
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

  it('never moves desktop-latest back to an older version', () => {
    const rolling = step(workflow().jobs.publish.steps, 'Refresh the rolling desktop-latest release').run

    const guard = rolling.indexOf('isOlderVersion(process.argv[1], process.argv[2])')
    expect(rolling).toContain("import { isOlderVersion } from './packages/desktop/scripts/bump-homebrew-cask.mjs'")
    expect(rolling).toContain('gh release view desktop-latest --repo "$REPO" --json name -q .name')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(rolling.slice(guard, rolling.indexOf('mkdir rolling'))).toContain('exit 0')
    expect(guard).toBeLessThan(rolling.indexOf('gh release upload desktop-latest'))
    expect(guard).toBeLessThan(rolling.indexOf('gh release edit desktop-latest'))
  })

  it('reports macOS signing under the same condition the build signs under', () => {
    const doc = workflow()
    const buildCondition = step(doc.jobs.build.steps, 'Signing status').env.HAS_APPLE
    const summary = step(doc.jobs.publish.steps, 'Write workflow summary')

    expect(buildCondition).toBe("${{ secrets.APPLE_CERTIFICATE != '' && secrets.APPLE_ID != '' }}")
    expect(summary.env.HAS_APPLE).toBe(buildCondition)
    expect(summary.run).toContain('ad-hoc signed, not notarized')
  })
})
