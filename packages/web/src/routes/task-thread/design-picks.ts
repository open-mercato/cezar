/**
 * Design Mode picks (spec `.ai/specs/2026-10-09-design-mode.md`) — what the picker reports about an
 * element the user clicked in the Browser column, and how that is told to the agent.
 *
 * Pure helpers only. What a pick BECOMES — a note with a prompt, a draft, a queued message — is
 * `task-workspace/design-notes.ts`.
 */

export const DESIGN_PICKS_SURFACE = 'design-picks'

/** More than this in one message is a page dump, not a selection. */
export const DESIGN_PICKS_MAX = 12

/** What `POST /runs/:id/messages` accepts — the same cap `messageWithReview` guards. */
const MESSAGE_TEXT_MAX = 100_000

export interface DesignPickRect {
  x: number
  y: number
  width: number
  height: number
}

/** One picked element, as the picker script described it. */
export interface NewDesignPick {
  /** The page it was picked on — the app's real address, never the proxy's. */
  url: string
  selector: string
  tag: string
  text: string
  html: string
  styles: Record<string, string>
  rect: DesignPickRect
  viewport: { width: number; height: number }
  /** Nearest first; empty outside a development build of React or Vue. */
  components: string[]
  /** `file:line` when the framework exposes it, else `''`. */
  source: string
  /**
   * The picker's handle on the live element, so the page can keep it framed and numbered while
   * the pick is part of a note. Valid only for the document it was picked in — after a reload it
   * names nothing, and the pick simply has no frame.
   */
  mark?: string
}

export interface DesignPick extends NewDesignPick {
  id: string
}

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0)

/**
 * A pick out of whatever arrived — from the framed page's `postMessage` or from the draft store.
 *
 * Defensive on purpose and bounded on every field: the sender is a page cezar does not control,
 * and what it sends ends up in a prompt. Anything that is not recognisably an element answers
 * `null`.
 */
export function parseDesignPick(raw: unknown): NewDesignPick | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const selector = str(r.selector, 400)
  const tag = str(r.tag, 40)
  if (selector === '' || tag === '') return null
  const rect = (r.rect ?? {}) as Record<string, unknown>
  const viewport = (r.viewport ?? {}) as Record<string, unknown>
  const styles: Record<string, string> = {}
  if (r.styles !== null && typeof r.styles === 'object') {
    for (const [name, value] of Object.entries(r.styles as Record<string, unknown>).slice(0, 30)) {
      if (typeof value === 'string' && /^[a-z-]{1,40}$/.test(name)) styles[name] = value.slice(0, 160)
    }
  }
  return {
    url: str(r.url, 2000),
    selector,
    tag,
    text: str(r.text, 200),
    html: str(r.html, 1600),
    styles,
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    viewport: { width: num(viewport.width), height: num(viewport.height) },
    components: Array.isArray(r.components)
      ? r.components.filter((name): name is string => typeof name === 'string').slice(0, 6).map((name) => name.slice(0, 80))
      : [],
    source: str(r.source, 300),
    ...(typeof r.mark === 'string' && /^[a-z0-9-]{1,24}$/.test(r.mark) ? { mark: r.mark } : {}),
  }
}

export function parseDesignPicks(text: string): DesignPick[] {
  if (text === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: DesignPick[] = []
  for (const item of raw as unknown[]) {
    const pick = parseDesignPick(item)
    const id = (item as { id?: unknown } | null)?.id
    if (pick && typeof id === 'string' && id !== '') out.push({ ...pick, id })
  }
  return out
}

/** What a chip calls a pick: the innermost component when there is one, else the selector's tail. */
export function pickLabel(pick: Pick<DesignPick, 'selector' | 'components' | 'tag'>): string {
  const tail = pick.selector.split(' > ').at(-1) ?? pick.tag
  return pick.components[0] ? `${pick.components[0]} · ${tail}` : tail
}

/** The line that opens the block in a sent message. */
export const DESIGN_HEADING = 'Elements selected in the app preview:'

/** A fence longer than any backtick run inside, so markup containing ``` cannot close it early. */
function fence(code: string, lang: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${lang}\n${code}\n${ticks}`
}

const indent = (body: string): string =>
  body
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')

/** What the agent receives: one block, every element with where it is, what renders it and its
 *  markup — enough to find it in the source without a screenshot. */
export function formatDesignPicks(picks: readonly DesignPick[]): string {
  if (picks.length === 0) return ''
  const blocks = picks.map((pick) => {
    const lines = [`- \`${pick.selector}\`${pick.url ? ` on ${pick.url}` : ''}`]
    if (pick.components.length > 0) {
      // Outermost first reads like a path into the tree.
      lines.push(`  component: ${[...pick.components].reverse().join(' › ')}${pick.source ? ` (${pick.source})` : ''}`)
    } else if (pick.source) {
      lines.push(`  source: ${pick.source}`)
    }
    lines.push(
      `  box: ${pick.rect.width}×${pick.rect.height} at ${pick.rect.x},${pick.rect.y} (viewport ${pick.viewport.width}×${pick.viewport.height})`,
    )
    if (pick.text) lines.push(`  text: ${JSON.stringify(pick.text)}`)
    const styles = Object.entries(pick.styles)
    if (styles.length > 0) lines.push(`  styles: ${styles.map(([name, value]) => `${name}: ${value}`).join('; ')}`)
    return `${lines.join('\n')}\n\n${indent(fence(pick.html, 'html'))}`
  })
  return `${DESIGN_HEADING}\n\n${blocks.join('\n\n')}`
}

/**
 * The message that carries the picks: whatever it already holds, then the elements. The typed
 * text stays first for the reason `withDiffComments` gives — a `/skill` is only expanded when the
 * message STARTS with it. Throws when the result would be refused by the server, so the host
 * keeps both the message and the picks.
 */
export function messageWithDesignPicks(text: string, picks: readonly DesignPick[]): string {
  const block = formatDesignPicks(picks)
  if (block === '') return text
  const message = text.trim() === '' ? block : `${text}\n\n${block}`
  if (message.length > MESSAGE_TEXT_MAX) {
    throw new Error(
      `Too long with the ${picks.length === 1 ? 'selected element' : `${picks.length} selected elements`} attached — remove some of them.`,
    )
  }
  return message
}
