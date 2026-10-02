import { describe, expect, it } from 'vitest'

import { DEFAULT_COCKPIT_ORIGIN, bookmarkletUrl, gitlabHostsFromProjects } from './bookmarklet'

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
    expect(code).not.toContain('/api/v1/health')
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

describe('bookmarkletUrl GitLab matcher (spec 2026-08-10-forge-provider-adapters, Step 4.5)', () => {
  it('with no GitLab host known, the matcher and alert are byte-identical to the pre-GitLab output', () => {
    const withoutHosts = bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4321', 'acme')
    const explicitlyEmpty = bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4321', 'acme', [])
    expect(withoutHosts).toBe(explicitlyEmpty)
    const code = program(withoutHosts)
    expect(code).toContain(
      String.raw`match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(pull|issues)\/\d+/)`,
    )
    // The message only — the guardian's no-native-dialogs rule scans test sources too, and the
    // generated program's dialog call is allowed in `bookmarklet.ts` alone.
    expect(code).toContain(`'Open a GitHub PR or issue first'`)
    expect(code).not.toContain('gitlab')
  })

  it('with gitlab.com and a self-managed host, the matcher also accepts GitLab MR/issue URLs on those hosts', () => {
    const code = program(
      bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.com', 'gitlab.acme.internal']),
    )
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    expect(matcher.test('https://gitlab.com/group/sub/repo/-/merge_requests/5')).toBe(true)
    expect(matcher.test('https://gitlab.com/group/repo/-/issues/3')).toBe(true)
    expect(matcher.test('https://gitlab.acme.internal/group/sub/repo/-/merge_requests/5')).toBe(true)
    expect(matcher.test('https://gitlab.acme.internal/group/repo/-/issues/3')).toBe(true)
    // gitlab.com redirects `/-/issues/N` to `/-/work_items/N`, so that is the URL the bookmarklet
    // actually sees on an issue page (verified live, 2026-10-01).
    expect(matcher.test('https://gitlab.com/group/sub/repo/-/work_items/3')).toBe(true)
    expect(matcher.test('https://gitlab.acme.internal/group/repo/-/work_items/3')).toBe(true)
    // GitHub still matches — this is additive, not a replacement.
    expect(matcher.test('https://github.com/open-mercato/cezar/pull/1')).toBe(true)
    // Rejects a host that is not in the known list.
    expect(matcher.test('https://gitlab.other.example/group/repo/-/merge_requests/5')).toBe(false)
    expect(code).toContain(`'Open a GitHub or GitLab pull/merge request or issue first'`)
  })

  it('escapes dots in a GitLab host so it cannot match an arbitrary character in their place', () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.acme.internal']))
    expect(code).toContain(String.raw`gitlab\.acme\.internal`)
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    // A host with the dot swapped for any other character must NOT match.
    expect(matcher.test('https://gitlabXacmeXinternal/group/repo/-/merge_requests/5')).toBe(false)
  })

  // Step 4.5-review-fix: the host comes from `new URL(project.repoUrl).host`, and for an IPv6
  // instance that is `[2001:db8::1]:8929`. Escaping only dots spliced those brackets into the
  // pattern as a character class — and an unbalanced `[` made the in-page `new RegExp` throw, so
  // the bookmarklet did nothing at all on every page.
  it('matches an IPv6 GitLab host literally instead of reading its brackets as a character class', () => {
    const code = program(
      bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.com', '[2001:db8::1]:8929']),
    )
    const source = code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1]
    expect(source).toBeDefined()
    const matcher = new RegExp(source as string)
    expect(matcher.test('https://[2001:db8::1]:8929/group/repo/-/merge_requests/12')).toBe(true)
    expect(matcher.test('https://[2001:db8::1]:8929/group/sub/repo/-/issues/3')).toBe(true)
    // The brackets are literal, so none of the characters inside them is a host of its own.
    expect(matcher.test('https://2/group/repo/-/merge_requests/12')).toBe(false)
    expect(matcher.test('https://gitlab.com/group/repo/-/merge_requests/12')).toBe(true)
  })

  it('survives a host carrying a lone `[` — the generated program still compiles', () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['we[ird.example']))
    const source = code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1]
    expect(source).toBeDefined()
    expect(() => new RegExp(source as string)).not.toThrow()
    const matcher = new RegExp(source as string)
    // The bracket is part of the host, not the start of a class that swallows the rest of it.
    expect(matcher.test('https://we[ird.example/group/repo/-/merge_requests/1')).toBe(true)
    // And GitHub — the half that has nothing to do with the odd host — still matches.
    expect(matcher.test('https://github.com/open-mercato/cezar/pull/1')).toBe(true)
  })

  // Step 5.7: `gitlabHostsFromProjects` harvests `new URL(repoUrl).host`, and `repoUrl` keeps the
  // remote's own scheme and port for a self-managed instance (Decision D3) — so an on-prem
  // `http://gitlab.acme.internal:8929` project's host was collected but could never match a
  // matcher pinned to `https:`.
  it('matches an http on-prem GitLab host on its own port', () => {
    const code = program(
      bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.com', 'gitlab.acme.internal:8929']),
    )
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    expect(matcher.test('http://gitlab.acme.internal:8929/group/repo/-/merge_requests/7')).toBe(true)
    expect(matcher.test('http://gitlab.acme.internal:8929/group/sub/repo/-/issues/3')).toBe(true)
    // The port is part of the host, so the bare hostname is still not a known host.
    expect(matcher.test('http://gitlab.acme.internal/group/repo/-/merge_requests/7')).toBe(false)
    // https on the same host keeps working, and so do the https-only hosts.
    expect(matcher.test('https://gitlab.acme.internal:8929/group/repo/-/merge_requests/7')).toBe(true)
    expect(matcher.test('https://gitlab.com/group/repo/-/merge_requests/5')).toBe(true)
    expect(matcher.test('http://gitlab.com/group/repo/-/merge_requests/5')).toBe(true)
    // An unknown host is still rejected under either scheme.
    expect(matcher.test('http://gitlab.other.example/group/repo/-/merge_requests/5')).toBe(false)
  })

  it('leaves the GitHub alternative pinned to https — only the GitLab half accepts http', () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.com']))
    expect(code).toContain(String.raw`^https:\/\/github\.com\/`)
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    expect(matcher.test('https://github.com/open-mercato/cezar/pull/1')).toBe(true)
    expect(matcher.test('http://github.com/open-mercato/cezar/pull/1')).toBe(false)
  })

  it('rejects a GitLab-shaped path with only one segment', () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.com']))
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    expect(matcher.test('https://gitlab.com/repo/-/issues/3')).toBe(false)
  })
})

describe('gitlabHostsFromProjects', () => {
  // Step 5.8: seeding `gitlab.com` unconditionally gave EVERY production launcher the GitLab
  // alternation and the wider alert, so the byte-identical GitHub output was true only of a
  // default no caller used.
  it('yields no host at all when the workspace has no GitLab project', () => {
    expect(gitlabHostsFromProjects(undefined)).toEqual([])
    expect(gitlabHostsFromProjects([])).toEqual([])
    expect(gitlabHostsFromProjects([{ forge: 'github', repoUrl: 'https://github.com/o/r' }, {}])).toEqual([])
  })

  it('a GitHub-only workspace regenerates the pre-GitLab launcher byte for byte', () => {
    const hosts = gitlabHostsFromProjects([
      { forge: 'github', repoUrl: 'https://github.com/o/r' },
      { forge: 'github', repoUrl: 'https://github.example.com/o/r' },
    ])
    const derived = bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4321', 'acme', hosts)
    expect(derived).toBe(bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4321', 'acme'))
    const code = program(derived)
    expect(code).toContain(`'Open a GitHub PR or issue first'`)
    expect(code).not.toContain('gitlab')
  })

  it('includes gitlab.com once a gitlab.com project is registered', () => {
    expect(gitlabHostsFromProjects([
      { forge: 'gitlab', repoUrl: 'https://gitlab.com/group/repo' },
      { forge: 'github', repoUrl: 'https://github.com/o/r' },
    ])).toEqual(['gitlab.com'])
  })

  it('adds a self-managed host from a forge: gitlab project with a repoUrl', () => {
    const hosts = gitlabHostsFromProjects([
      { forge: 'gitlab', repoUrl: 'https://gitlab.acme.internal/group/sub/repo' },
      { forge: 'github', repoUrl: 'https://github.com/o/r' },
      { forge: 'gitlab' }, // no repoUrl — skipped
      {},
    ])
    // A self-managed-only workspace is still a GitLab workspace, so gitlab.com rides along.
    expect(hosts).toContain('gitlab.com')
    expect(hosts).toContain('gitlab.acme.internal')
    expect(hosts).not.toContain('github.com')
    expect(hosts).toHaveLength(2)
  })

  it('keeps the scheme-bearing host of an http on-prem instance (port included)', () => {
    expect(gitlabHostsFromProjects([{ forge: 'gitlab', repoUrl: 'http://gitlab.acme.internal:8929/group/repo' }]))
      .toEqual(['gitlab.com', 'gitlab.acme.internal:8929'])
  })

  it('de-duplicates when a project already lives on gitlab.com', () => {
    const hosts = gitlabHostsFromProjects([{ forge: 'gitlab', repoUrl: 'https://gitlab.com/group/repo' }])
    expect(hosts).toEqual(['gitlab.com'])
  })

  it('skips a malformed repoUrl without throwing', () => {
    expect(() => gitlabHostsFromProjects([{ forge: 'gitlab', repoUrl: 'not a url' }])).not.toThrow()
    expect(gitlabHostsFromProjects([{ forge: 'gitlab', repoUrl: 'not a url' }])).toEqual(['gitlab.com'])
  })
})
