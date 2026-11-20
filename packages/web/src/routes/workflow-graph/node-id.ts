const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export type NodeIdResult = { ok: true; id: string } | { ok: false; reason: 'empty' | 'taken' | 'invalid'; id: string }

/** Turn what a user typed ("Run tests", "build.step") into a valid node id; the server rule is `NODE_ID_RE`. */
export function slugifyNodeId(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '')
}

/** Resolve a typed node id: slugify it, accept the node's own id, and say why when it cannot be used. */
export function resolveNodeId(draft: string, currentId: string, allIds: readonly string[]): NodeIdResult {
  if (!draft.trim()) return { ok: false, reason: 'empty', id: currentId }
  const id = NODE_ID_RE.test(draft.trim()) ? draft.trim() : slugifyNodeId(draft)
  if (!NODE_ID_RE.test(id)) return { ok: false, reason: 'invalid', id }
  if (id === currentId) return { ok: true, id }
  if (allIds.includes(id)) return { ok: false, reason: 'taken', id }
  return { ok: true, id }
}
