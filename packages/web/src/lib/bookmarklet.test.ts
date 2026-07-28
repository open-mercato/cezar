import { describe, expect, it } from 'vitest'

import { DEFAULT_COCKPIT_ORIGIN, bookmarkletUrl } from './bookmarklet'

/** The program text a browser would actually execute when the bookmarklet is clicked. */
const program = (url: string) => decodeURIComponent(url.replace(/^javascript:/, ''))

describe('bookmarkletUrl (spec 011, protected /new deep-link contract)', () => {
  it('is a javascript: URL wrapping one URI-encoded expression', () => {
    const url = bookmarkletUrl('om-fix', true, 'sekret')
    expect(url.startsWith('javascript:')).toBe(true)
    // The raw URL carries no whitespace or double quotes — it must survive a bookmarks bar.
    expect(url).not.toMatch(/[\s"]/)
  })

  it('the generic launcher (no skill) omits skill= and never auto-starts', () => {
    const code = program(bookmarkletUrl('', false, 'sekret'))
    expect(code).toContain(`q='auto=0&key=sekret&ref='`)
    expect(code).not.toContain('skill=')
  })

  it('a per-skill launcher bakes skill=, the auto flag and the launch key into /new', () => {
    const code = program(bookmarkletUrl('om-fix', true, 'sekret'))
    expect(code).toContain(`q='skill=om-fix&auto=1&key=sekret&ref='`)
    expect(code).toContain(`/new?'+q`)
  })

  it('opens the baked cockpit origin directly — no CSP-blocked localhost fetch', () => {
    // GitHub's CSP blocks fetch/XHR to localhost, so the launcher must NAVIGATE, not probe.
    const code = program(bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327'))
    expect(code).toContain(`open('http://localhost:4327/new?'+q,'_blank')`)
    expect(code).not.toContain('/api/health')
    expect(code).not.toContain('fetch(')
  })

  it('defaults to the cockpit default origin when a caller supplies none', () => {
    const code = program(bookmarkletUrl('', false, ''))
    expect(code).toContain(`open('${DEFAULT_COCKPIT_ORIGIN}/new?'+q,'_blank')`)
    expect(DEFAULT_COCKPIT_ORIGIN).toBe('http://localhost:4321')
  })

  it('the page URL rides along as ref= at click time', () => {
    const code = program(bookmarkletUrl('om-fix', false, 'k'))
    expect(code).toContain(`ref='+encodeURIComponent(location.href)`)
  })

  it("escapes apostrophes in skill and key — they would break the embedded '…' string", () => {
    const code = program(bookmarkletUrl("bob's-skill", false, "k'ey"))
    expect(code).toContain('skill=bob%27s-skill')
    expect(code).toContain('key=k%27ey')
    // No stray apostrophe beyond the intentional string delimiters around the query.
    expect(code).toContain(`q='skill=bob%27s-skill&auto=0&key=k%27ey&ref='`)
  })

  it('names the project in the path when one is given (multi-project spec, step 3.6)', () => {
    const code = program(bookmarkletUrl('om-fix', true, 'acme-key', 'http://localhost:4321', 'acme'))
    expect(code).toContain(`open('http://localhost:4321/p/acme/new?'+q,'_blank')`)
    // Only the PATH gained a prefix — the protected query grammar is character-for-character
    // what it was, and the key is the one that project's cockpit scope will accept.
    expect(code).toContain(`q='skill=om-fix&auto=1&key=acme-key&ref='`)
  })

  it('omits the prefix without a project — byte-identical to the legacy launcher', () => {
    // The single-project spelling must survive verbatim: it is what every already-saved
    // bookmarklet contains, and the cockpit redirects it onto the boot project.
    const scoped = bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327')
    expect(scoped).toBe(bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327', null))
    expect(scoped).toBe(bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327', ''))
    expect(program(scoped)).toContain(`open('http://localhost:4327/new?'+q,'_blank')`)
  })

  it("escapes a project id — a slug with an apostrophe would break the embedded '…' string", () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', "o'brien/repo"))
    expect(code).toContain(`open('http://localhost:4321/p/o%27brien%2Frepo/new?'+q,'_blank')`)
    expect(bookmarkletUrl('', false, 'k', 'http://localhost:4321', "o'brien")).not.toMatch(/[\s"]/)
  })

  it('only fires on GitHub PR/issue pages', () => {
    const code = program(bookmarkletUrl('', false, ''))
    expect(code).toContain('github\\.com')
    expect(code).toContain('(pull|issues)')
  })
})
