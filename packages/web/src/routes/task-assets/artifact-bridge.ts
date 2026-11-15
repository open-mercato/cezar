import { useEffect, useRef, type RefObject } from 'react'

import { artifactRefMessageSchema } from '@open-mercato/cezar-api-client'

/**
 * The Assets frame's ONE inbound message (spec 2026-10-22-html-artifacts-and-impact, R4 "Ask and
 * correct"). A reference only ever becomes a removable chip in the docked composer: the cockpit
 * never sends, navigates or acts on the frame's behalf.
 */

export const ARTIFACT_REF_LABEL_MAX = 200

export interface ArtifactReference {
  ref: string
  label: string
}

/** The schema from the contract, then the label cap. Anything else — `{type:'send'}`, a bare
 *  string, an over-long ref — is `null` and dropped. */
export function parseArtifactRef(data: unknown): ArtifactReference | null {
  const parsed = artifactRefMessageSchema.safeParse(data)
  if (!parsed.success) return null
  return { ref: parsed.data.ref, label: parsed.data.label.slice(0, ARTIFACT_REF_LABEL_MAX) }
}

/** What the agent receives: `About <ref> ("<label>"): <text>` — the plain text without a chip. */
export function askMessage(reference: ArtifactReference | null, text: string): string {
  return reference ? `About ${reference.ref} ("${reference.label}"): ${text}` : text
}

/**
 * Listen for references from THIS frame only: `event.source` must be the iframe's own window,
 * so another tab, a popup or a second frame can never place a chip.
 */
export function useArtifactRefBridge(
  frameRef: RefObject<HTMLIFrameElement | null>,
  onReference: (reference: ArtifactReference) => void,
): void {
  const latest = useRef(onReference)
  latest.current = onReference
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow
      if (!frame || event.source !== frame) return
      const reference = parseArtifactRef(event.data)
      if (reference) latest.current(reference)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef])
}
