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
    expect(replaceRun).toContain("$env:SIGNPATH_SIGNING_POLICY -eq 'release-signing'")
    expect(replaceRun).toContain('$signature.Status -ne \'Valid\'')
    expect(replaceRun).toContain('The installer is signed but not trusted by Windows under policy')
    expect(replaceRun).toContain('rm -f "$INSTALLER.sig"')
    expect(replaceRun).toContain('npx tauri signer sign "$INSTALLER"')
    expect(upload).toBeGreaterThan(authenticode)
  })

  it('falls back to the unsigned installer only when a non-release SignPath policy fails', () => {
    const buildSteps = workflow().jobs.build.steps
    const signPathStep = step(buildSteps, 'Sign the installer with SignPath')
    const fallback = step(buildSteps, 'Report the unsigned Windows fallback')
    const replaceStep = step(buildSteps, 'Put the signed installer in place')

    // desktop-v0.1.12: a transient "Invalid URL for GitHub API" from the connector held the release.
    expect(signPathStep['continue-on-error']).toBe("${{ (vars.SIGNPATH_SIGNING_POLICY_SLUG || 'release-signing') != 'release-signing' }}")
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
    expect(job.if).toBe('${{ !inputs.dry_run }}')
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
})
