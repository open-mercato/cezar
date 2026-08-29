import { useEffect } from 'react'

export interface DocumentTitleParts {
  projectName: string | null
  pageLabel: string | null
}

function titlePart(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The browser-tab grammar, kept pure so loading and fallback states are exhaustive in tests.
 *  Slash between the parts, the app name in parens (house rule: no "—"/"·" separators). */
export function documentTitleOf({ projectName, pageLabel }: DocumentTitleParts): string {
  const project = titlePart(projectName)
  const page = titlePart(pageLabel)

  const parts = [project, page].filter((part): part is string => part !== null)
  return parts.length > 0 ? `${parts.join(' / ')} (cezar)` : 'cezar'
}

/** The cockpit's single runtime document-title writer. */
export function useDocumentTitle(parts: DocumentTitleParts): void {
  const title = documentTitleOf(parts)
  useEffect(() => {
    document.title = title
  }, [title])
}
