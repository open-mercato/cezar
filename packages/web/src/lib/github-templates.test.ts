import { describe, expect, it } from 'vitest'

import { GITHUB_TEMPLATE_SUGGESTIONS, filterTemplateSuggestions } from '@/lib/github-templates'

describe('GitHub template suggestions', () => {
  it('are unique owner/repo slugs', () => {
    const slugs = GITHUB_TEMPLATE_SUGGESTIONS.map((s) => s.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) expect(slug).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
  })

  it('filter by label, slug or description, and list everything for an empty or exact query', () => {
    expect(filterTemplateSuggestions('')).toHaveLength(GITHUB_TEMPLATE_SUGGESTIONS.length)
    expect(filterTemplateSuggestions('github/codespaces-nextjs')).toHaveLength(GITHUB_TEMPLATE_SUGGESTIONS.length)
    expect(filterTemplateSuggestions('PYTHON').map((s) => s.slug)).toContain('microsoft/python-package-template')
    expect(filterTemplateSuggestions('electron').map((s) => s.slug)).toEqual(['electron/electron-quick-start'])
    expect(filterTemplateSuggestions('no-such-template-anywhere')).toEqual([])
  })
})
