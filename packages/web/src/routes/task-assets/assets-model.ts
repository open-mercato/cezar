import type { RunArtifact } from '@open-mercato/cezar-api-client'

/**
 * The Assets view's pure half (spec 2026-10-22-html-artifacts-and-impact § UI/UX → Assets view).
 */

/** Newest first, name as the tie-break so the order never flickers between equal mtimes. */
export function byNewest(artifacts: readonly RunArtifact[]): RunArtifact[] {
  return [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
}

/** What opens when the URL names nothing (or a file that is gone): `impact.html`, else the newest
 *  HTML page, else the newest file. */
export function defaultArtifact(artifacts: readonly RunArtifact[]): RunArtifact | undefined {
  const impact = artifacts.find((artifact) => artifact.name === 'impact.html')
  if (impact) return impact
  const sorted = byNewest(artifacts)
  return sorted.find((artifact) => artifact.kind === 'html') ?? sorted[0]
}

export function pickArtifact(artifacts: readonly RunArtifact[], name: string | undefined): RunArtifact | undefined {
  return (name === undefined ? undefined : artifacts.find((artifact) => artifact.name === name)) ?? defaultArtifact(artifacts)
}

export function artifactLabel(artifact: RunArtifact): string {
  return artifact.title?.trim() || artifact.name
}

export const KIND_LABELS: Record<RunArtifact['kind'], string> = {
  html: 'HTML',
  markdown: 'Markdown',
  image: 'Image',
  json: 'JSON',
  other: 'File',
}

/** The iframe's sandbox. NEVER `allow-same-origin`: with it, agent-authored script would run in the
 *  cockpit's origin and could call the API (spec § Risks — the load-bearing paragraph). */
export const ARTIFACT_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

/** Per-view Focus preference (R2), per browser. Only Assets offers it today. */
const FOCUS_STORAGE_KEY = 'cez-view-focus'

export function readViewFocus(view: string): boolean {
  try {
    const raw = localStorage.getItem(FOCUS_STORAGE_KEY)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)[view] === true
  } catch {
    return false
  }
}

export function writeViewFocus(view: string, on: boolean): void {
  try {
    const raw = localStorage.getItem(FOCUS_STORAGE_KEY)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    const map = typeof parsed === 'object' && parsed !== null ? { ...(parsed as Record<string, unknown>) } : {}
    map[view] = on
    localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Private mode or a full quota: Focus still works for this visit.
  }
}
