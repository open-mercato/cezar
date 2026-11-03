import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  documentTitleOf,
  type DocumentTitleParts,
  useDocumentTitle,
} from './use-document-title'

describe('documentTitleOf', () => {
  it.each([
    {
      name: 'project and page',
      projectName: 'Storefront',
      pageLabel: 'Tasks',
      expected: 'Storefront — Tasks · cezar',
    },
    {
      name: 'project only',
      projectName: 'Storefront',
      pageLabel: null,
      expected: 'Storefront · cezar',
    },
    {
      name: 'page only',
      projectName: null,
      pageLabel: 'Settings',
      expected: 'Settings · cezar',
    },
    { name: 'neither part', projectName: null, pageLabel: null, expected: 'cezar' },
    { name: 'empty project', projectName: '', pageLabel: 'Tasks', expected: 'Tasks · cezar' },
    { name: 'blank parts', projectName: '  ', pageLabel: '\t', expected: 'cezar' },
  ])('formats $name', ({ projectName, pageLabel, expected }) => {
    expect(documentTitleOf({ projectName, pageLabel })).toBe(expected)
  })

  it('uses the configured workspace name', () => {
    expect(documentTitleOf({ projectName: 'Storefront', pageLabel: 'Tasks', brandName: 'Acme Studio' }))
      .toBe('Storefront — Tasks · Acme Studio')
  })
})

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'cezar'
  })

  it('updates the existing writer when its truthful inputs change', () => {
    const initialProps: DocumentTitleParts = {
      projectName: 'Storefront',
      pageLabel: 'Tasks',
    }
    const { rerender } = renderHook(
      (parts: DocumentTitleParts) => useDocumentTitle(parts),
      { initialProps },
    )

    expect(document.title).toBe('Storefront — Tasks · cezar')
    rerender({ projectName: 'Back office', pageLabel: null })
    expect(document.title).toBe('Back office · cezar')
  })

  it('updates the tab icon to the instance logo and restores the product icon when cleared', () => {
    const { rerender } = renderHook((parts: DocumentTitleParts) => useDocumentTitle(parts), {
      initialProps: { projectName: null, pageLabel: null, brandLogoUrl: '/api/v1/workspace/branding-logo?v=abc' } as DocumentTitleParts,
    })
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!
    expect(icon.href).toContain('/api/v1/workspace/branding-logo?v=abc')
    rerender({ projectName: null, pageLabel: null, brandLogoUrl: null })
    expect(icon.getAttribute('href')).toBe('/icon.svg')
  })
})
