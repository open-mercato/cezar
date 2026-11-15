import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Declarations of every rule whose selector list matches `selector` exactly. */
function rulesFor(selector: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((m[1] ?? '').split(',').map((s) => s.trim()).includes(selector)) out.push(m[2] ?? '')
  }
  return out
}

// #1977: the onboarding surfaces (/new, automations editor, first run) ignored the chosen accent.
describe('onboarding surfaces follow the accent', () => {
  it('never pins --primary or --ring on a bare [data-onboarding]', () => {
    for (const body of rulesFor('[data-onboarding]')) {
      expect(body).not.toMatch(/--primary\s*:/)
      expect(body).not.toMatch(/--primary-foreground\s*:/)
      expect(body).not.toMatch(/--ring\s*:/)
    }
  })

  it('only darkens --primary for the violet accent', () => {
    const [violet] = rulesFor(":root[data-accent='violet'] [data-onboarding]")
    expect(violet).toMatch(/--primary\s*:\s*#6457e8/)
  })
})
