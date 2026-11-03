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

  it('refreshes manifest signatures from release assets before publishing desktop-latest.json', () => {
    const publishRun = step(workflow().jobs.publish.steps, 'Rename the updater manifest and publish').run

    expect(publishRun).toContain("gh release download \"$TAG\" --repo \"$REPO\" --pattern '*.sig' --dir sigs")
    expect(publishRun).toContain('node packages/desktop/scripts/refresh-updater-manifest.mjs desktop-latest.json sigs')
    expect(publishRun).toContain('gh release upload "$TAG" desktop-latest.json --clobber --repo "$REPO"')
  })
})
