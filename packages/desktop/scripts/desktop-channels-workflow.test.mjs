import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const doc = parse(readFileSync(path.join(root, '.github/workflows/desktop-channels.yml'), 'utf8'))

describe('desktop channels workflow (#1763)', () => {
  it('runs read-only by default and defaults a manual run to a dry run', () => {
    expect(doc.permissions).toEqual({ contents: 'read' })
    expect(doc.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
  })

  it('pushes only when not a dry run AND the channel credential exists', () => {
    const push = (job, name) => doc.jobs[job].steps.find(s => s.name === name)
    const winget = push('winget', 'Submit to winget-pkgs')
    const aur = push('aur', 'Push to the AUR')
    expect(winget.if).toContain("dry_run != 'true'")
    expect(winget.if).toContain("env.HAS_TOKEN == 'true'")
    expect(winget.env.GH_TOKEN).toBe('${{ secrets.WINGET_PKGS_TOKEN }}')
    expect(aur.if).toContain("dry_run != 'true'")
    expect(aur.if).toContain("env.HAS_KEY == 'true'")
  })

  it('never writes with github.token', () => {
    for (const job of ['winget', 'aur']) {
      for (const step of doc.jobs[job].steps) expect(JSON.stringify(step)).not.toContain('github.token')
    }
  })
})
