import { useEffect } from 'react'

export interface DocumentTitleParts {
  projectName: string | null
  pageLabel: string | null
  brandName?: string | null
  brandLogoUrl?: string | null
}

function titlePart(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The browser-tab grammar, kept pure so loading and fallback states are exhaustive in tests. */
export function documentTitleOf({ projectName, pageLabel, brandName }: DocumentTitleParts): string {
  const project = titlePart(projectName)
  const page = titlePart(pageLabel)
  const brand = titlePart(brandName ?? null) ?? 'cezar'

  if (project && page) return `${project} — ${page} · ${brand}`
  if (project) return `${project} · ${brand}`
  if (page) return `${page} · ${brand}`
  return brand
}

/** The cockpit's single runtime document-title writer. */
export function useDocumentTitle(parts: DocumentTitleParts): void {
  const title = documentTitleOf(parts)
  useEffect(() => {
    document.title = title
  }, [title])
  useEffect(() => {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!icon) {
      icon = document.createElement('link')
      icon.rel = 'icon'
      document.head.append(icon)
    }
    icon.href = parts.brandLogoUrl ?? '/icon.svg'
    icon.type = parts.brandLogoUrl?.includes('.svg?') ? 'image/svg+xml' : ''
  }, [parts.brandLogoUrl])
}
