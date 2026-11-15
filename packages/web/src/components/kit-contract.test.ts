import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The shared component kit's contract with the UI strategy (redesign 2026-11), as static scans
 * over `src/components/**` — the same shape as `design-guardian.test.ts`, scoped to the kit:
 *
 *  - no native `<select>` (Radix `ui/select` or a Command popover);
 *  - no `<input type="number">` (that is `IntegerStepper`);
 *  - a tooltip is ONE line: no block children, no per-call width override — labelled multi-line
 *    content is a Popover;
 *  - `text-xs text-soft-foreground` never carries real information (`text-label text-muted-foreground`);
 *  - lime lives only in the wordmark gradient.
 *
 * Files in `NOT_SWEPT` belong to other owners (composer, pickers, shell, diff…) and are skipped
 * for the rules that are still open there; delete an entry once that file is swept.
 */

const COMPONENTS_DIR = path.dirname(fileURLToPath(import.meta.url))

const NOT_SWEPT = new Set([
  'add-project-menu.tsx',
  'app-shell.tsx',
  'composer/composer.tsx',
  'current-tasks.tsx',
  'diff/diff-view.tsx',
  'diff/diff.tsx',
  'diff/image-preview.tsx',
  'diff/markdown-preview.tsx',
  'dispatch-toggle.tsx',
  'project-switcher.tsx',
  'run-diff.tsx',
  'sidebar-status-line.tsx',
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(COMPONENTS_DIR).map((abs) => ({
  rel: path.relative(COMPONENTS_DIR, abs).split(path.sep).join('/'),
  source: readFileSync(abs, 'utf8'),
}))

/** Strip `//` and `/* *\/` comments so a rule's own name in a doc comment is not a violation. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

const swept = files.filter((f) => !NOT_SWEPT.has(f.rel))

function violations(subject: typeof files, pattern: RegExp): string[] {
  const out: string[] = []
  for (const file of subject) {
    for (const match of code(file.source).matchAll(pattern)) out.push(`${file.rel}: ${match[0].trim().slice(0, 60)}`)
  }
  return out
}

describe('component kit contract', () => {
  it('scans the kit', () => {
    expect(files.length).toBeGreaterThan(60)
    expect(files.some((f) => f.rel === 'ui/button.tsx')).toBe(true)
  })

  it('has no native <select> — lists are ui/select or a Command popover', () => {
    expect(violations(files, /<select\b/g)).toEqual([])
  })

  it('has no <input type="number"> — whole numbers are an IntegerStepper', () => {
    expect(violations(swept, /type=["']number["']/g)).toEqual([])
  })

  it('tooltips are one line: no block children and no per-call width override', () => {
    const out: string[] = []
    for (const file of swept) {
      const src = code(file.source)
      for (const match of src.matchAll(/<TooltipContent\b[\s\S]*?<\/TooltipContent>/g)) {
        const block = match[0]
        if (/<(?:div|p|br|ul|li|h\d)\b/.test(block)) out.push(`${file.rel}: block child inside a tooltip`)
        if (/className="[^"]*\b(?:block|max-w-)/.test(block)) out.push(`${file.rel}: tooltip overrides the shared shape`)
      }
      for (const match of src.matchAll(/<IconTooltip\b[^>]*label=\{\s*</g)) {
        out.push(`${file.rel}: IconTooltip label is markup, not a sentence (${match[0].slice(0, 30)}…)`)
      }
    }
    expect(out).toEqual([])
  })

  it('does not pair text-xs with text-soft-foreground for information — that is text-label text-muted-foreground', () => {
    expect(violations(swept, /\btext-xs\b[^"'`]*\btext-soft-foreground\b|\btext-soft-foreground\b[^"'`]*\btext-xs\b/g)).toEqual([])
  })

  it('keeps lime for the wordmark only', () => {
    const out = violations(files, /accent-lime|\blime\b/g).filter((v) => !v.startsWith('brand-mark.tsx'))
    expect(out).toEqual([])
  })

  it('never reaches for the Tailwind palette or raw hex', () => {
    expect(violations(files, /\b(?:text|bg|border|fill|stroke)-(?:green|red|amber|blue|yellow|emerald|orange|sky|gray|zinc|slate|purple|indigo|lime)-\d{2,3}\b/g)).toEqual([])
  })
})
