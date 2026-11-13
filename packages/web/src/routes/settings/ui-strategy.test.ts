import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SETTINGS_SECTIONS } from './registry'

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

/** The opening tag starting at `open`: up to the first `>` that is not an arrow's. */
function openingTag(code: string, open: number): string {
  for (let i = open; i < code.length; i++) if (code[i] === '>' && code[i - 1] !== '=') return code.slice(open, i + 1)
  return code.slice(open)
}

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
    // The one exception the strategy allows: revealing a `truncate`d element's own full text.
    const offenders = sources.filter(({ text }) => {
      const code = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      return [...code.matchAll(/\btitle=/g)].some((match) => {
        const open = code.lastIndexOf('<', match.index)
        if (!/^<[a-z]/.test(code.slice(open, open + 2))) return false
        return !/\btruncate\b/.test(openingTag(code, open))
      })
    })
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

/**
 * Copy that names a settings place ("Settings → Privacy") must name a page the rail still shows —
 * the merged pages' old names (Resources, Transfer, Privacy, Agent accounts) are redirects now.
 */
describe('user-facing copy names settings pages that exist', () => {
  const titles = new Set(
    SETTINGS_SECTIONS.filter((section) => !section.redirect && !section.hidden).map((section) => section.title),
  )
  const outside = ['../../components/telemetry-consent.tsx', '../../components/host-usage-widget.tsx', '../../api/agent-accounts.ts']
  const files = [
    ...readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)),
    ...outside,
  ].map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
  // Comments may cite history; only code and copy count.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('every "Settings → X" / "Settings, X" names a current section', () => {
    const stale: string[] = []
    for (const { name, text } of files) {
      for (const match of code(text).matchAll(/(?<!(?:Server|System) )Settings(?: →|,) (.*)$/gm)) {
        const rest = match[1]!
        const known = [...titles].some((title) => rest.startsWith(title) && !/^[A-Za-z]/.test(rest.slice(title.length)))
        if (!known) stale.push(`${name}: ${match[0]}`)
      }
    }
    expect(stale).toEqual([])
  })

  it('never names the retired "General settings" area', () => {
    expect(files.filter(({ text }) => /General settings/.test(code(text))).map((f) => f.name)).toEqual([])
  })

  it('the guard sees the files it is meant to', () => {
    expect(files.map((f) => f.text).join('\n')).toContain('Settings → Data & privacy')
  })
})
