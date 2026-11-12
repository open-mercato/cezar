import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The UI-strategy sweep of Settings (redesign 2026-11): rules that hold for EVERY section source
 * file in this directory, pinned once here so the next section cannot quietly regress them.
 * Per-section render tests cover the behaviour; this is the grep.
 */
const dir = import.meta.dirname
/** Rewritten in the redesign pass itself (or the shell/registry), outside this sweep's remit. */
const OUT_OF_SCOPE = ['settings-shell.tsx', 'registry.tsx', 'form-row.tsx', 'appearance.tsx', 'agents-global-section.tsx', 'behaviour-section.tsx', 'data-privacy-section.tsx']
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx') && !OUT_OF_SCOPE.includes(name))
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))

describe('settings sources follow the UI strategy', () => {
  it('scans a real directory', () => {
    expect(sources.length).toBeGreaterThan(30)
  })

  it('never renders a native <select> — every list is components/ui/select', () => {
    expect(sources.filter(({ text }) => /<select[\s>]/.test(text)).map((s) => s.name)).toEqual([])
  })

  it('never renders <input type="number"> — whole numbers go through IntegerStepper', () => {
    expect(sources.filter(({ text }) => /type=["']number["']/.test(text)).map((s) => s.name)).toEqual([])
  })

  it('carries no informational text-xs + text-soft-foreground pair (use text-label text-muted-foreground)', () => {
    expect(sources.filter(({ text }) => /text-xs text-soft-foreground|text-soft-foreground text-xs/.test(text)).map((s) => s.name)).toEqual([])
  })

  it('never hand-rolls a destructive button — Button variant="destructive" / buttonVariants', () => {
    expect(sources.filter(({ text }) => /bg-danger text-danger-foreground/.test(text)).map((s) => s.name)).toEqual([])
  })

  it('puts no native title= on an HTML element (one-line Tooltip instead; component `title` props are fine)', () => {
    // A `title=` whose opening tag is a lowercase HTML element; `<SettingsCard title=` is a prop.
    const offenders = sources.filter(({ text }) => /<[a-z][a-z0-9]*\b[^>]*\btitle=/.test(text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')))
    expect(offenders.map((s) => s.name)).toEqual([])
  })

  it('every section uses the shared form grammar (SettingsCard / FormRow), never the retired SettingsField', () => {
    expect(sources.some(({ name }) => name === 'settings-field.tsx')).toBe(false)
    expect(sources.filter(({ text }) => /SettingsField/.test(text)).map((s) => s.name)).toEqual([])
    const sections = sources.filter(({ name }) => /-section\.tsx$/.test(name) || ['project-general.tsx', 'worktree-lifecycle-editor.tsx', 'trunk-based-fields.tsx', 'provider-settings.tsx'].includes(name))
    const withoutRows = sections.filter(({ text }) => !/\b(FormRow|SettingsCard)\b/.test(text))
    // Not forms: a per-file config editor, a tabs host, and a bookmarklet list — they carry no
    // setting rows of their own, so the row grammar does not apply to them.
    const notForms = ['agent-config-section.tsx', 'integrations-section.tsx', 'bookmarklets-section.tsx']
    expect(withoutRows.map((s) => s.name).filter((name) => !notForms.includes(name))).toEqual([])
  })
})
