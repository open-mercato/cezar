import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/* tailwind-merge ships Tailwind's stock scales, but our theme (styles/index.css) replaces the shadow
 * scale with xs/sm/md/modal. `shadow-modal` is not a name it knows, so it would classify it as a
 * shadow *color* and let it coexist with `shadow-md` instead of overriding it. Teaching it the extra
 * step keeps "last utility wins" true for shadows too.
 * The radius scale needs no extension: sm/md/lg/xl are all stock names.
 * The type scale (`--text-micro` … `--text-lead`, typography audit 2026-10-30) is the same story:
 * unknown to it, `text-ui` reads as a text COLOUR, so `cn('text-ui', 'text-muted-foreground')`
 * silently dropped the size — and `cn('text-primary-foreground', 'text-ui')` the colour.
 */
export const TYPE_SCALE = ['text-micro', 'text-meta', 'text-label', 'text-ui', 'text-body', 'text-lead'] as const
const twMerge = extendTailwindMerge({
  extend: { classGroups: { shadow: ['shadow-modal'], 'font-size': [...TYPE_SCALE] } },
})

/** Join conditional class names, letting later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * True only for `http:`/`https:` URLs (#431 — href protocol guard). React does
 * NOT sanitize `href` at runtime, so a `javascript:`/`data:`/`vbscript:` value
 * would execute on click. Most link URLs are server-minted GitHub links, but a
 * few are scraped from the agent transcript (PR URLs), i.e. agent-influenceable
 * — so components render a link only when this passes, and inert text otherwise.
 */
export function isHttpUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}
