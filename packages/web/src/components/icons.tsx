import type { SVGProps } from 'react'

import claudeLogo from '@/assets/runners/claude.svg'
import codexLogo from '@/assets/runners/codex.svg'
import opencodeLogo from '@/assets/runners/opencode.svg'

/** The coding-agent backends' own brand marks (assets/runners/*.svg). Rendered as an <img> — they
 *  are multi-colour logos (Claude's burst, the OpenAI mark, OpenCode's tile), not monochrome glyphs,
 *  so `currentColor` would flatten them. `object-contain` keeps each logo's own aspect ratio inside
 *  a square box. Unknown runner → null, and the caller falls back to a lucide bot. */
const RUNNER_LOGOS: Record<string, string | undefined> = {
  claude: claudeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
}

export function RunnerLogo({ runner, className }: { runner: string; className?: string }) {
  const src = RUNNER_LOGOS[runner]
  if (!src) return null
  return <img src={src} alt="" aria-hidden className={`object-contain ${className ?? ''}`} />
}

/** A pixel-art hammer (Streamline Pixel, "interface-essential-hammer-2") — the brand motto's
 *  glyph. currentColor like every other icon here, so the caller picks the violet. */
export function PixelHammerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M29.71 11.43h1.53v3.05h-1.53ZM28.19 14.48h1.52V16h-1.52ZM26.67 16h1.52v1.52h-1.52ZM26.67 9.91h3.04v1.52h-3.04ZM25.14 11.43h1.53v1.52h-1.53ZM25.14 8.38h1.53v1.53h-1.53ZM23.62 17.52h3.05v1.53h-3.05ZM23.62 12.95h1.52v1.53h-1.52ZM23.62 6.86h1.52v1.52h-1.52ZM22.1 14.48h1.52v3.04H22.1ZM22.1 5.33h1.52v1.53H22.1ZM20.57 12.95h1.53v1.53h-1.53ZM20.57 3.81h1.53v1.52h-1.53ZM19.05 14.48h1.52V16h-1.52ZM19.05 2.29h1.52v1.52h-1.52Zm-1.53 12.19 -1.52 0 0 -1.53 -1.52 0 0 1.53 -1.53 0 0 1.52 1.53 0 0 1.52 -1.53 0 0 1.53 -1.52 0 0 1.52 -1.52 0 0 -1.52 -1.53 0 0 1.52 -1.52 0 0 1.53 -1.53 0 0 1.52 -1.52 0 0 1.52 -1.52 0 0 1.53 -1.53 0 0 3.05 1.53 0 0 1.52 3.04 0 0 -1.52 1.53 0 0 -1.53 1.52 0 0 -1.52 1.53 0 0 -1.53 1.52 0 0 -1.52 1.52 0 0 -1.52 1.53 0 0 -1.53 1.52 0 0 -1.52 1.52 0 0 -1.53 1.53 0 0 -1.52 -1.53 0 0 -1.52zM16 9.91h1.52v3.04H16ZM14.48 0.76h4.57v1.53h-4.57ZM14.48 8.38H16v1.53h-1.52ZM11.43 6.86h3.05v1.52h-3.05ZM11.43 2.29h3.05v1.52h-3.05ZM11.43 16h1.52v1.52h-1.52ZM9.91 17.52h1.52v1.53H9.91ZM9.91 8.38h1.52v1.53H9.91ZM9.91 3.81h1.52v1.52H9.91ZM8.38 5.33h1.53v3.05H8.38Z" />
    </svg>
  )
}

/** Brand marks that lucide does not ship.
 *
 *  lucide-react 1.x removed every brand icon (no `GithubIcon`), so the forge nav item would
 *  otherwise have no mark. The path is the one the mockups use, kept at lucide's 24×24 viewBox
 *  and `currentColor` fill so it sizes and themes exactly like its neighbours in the nav.
 */
export function GithubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 1.9a10.1 10.1 0 0 0-3.2 19.7c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.1 10.1 0 0 0 12 1.9z" />
    </svg>
  )
}

/** Claude's radial burst (Anthropic mark), same 24×24 / currentColor contract as the others so it
 *  sizes and themes like a lucide glyph. Ten rounded spokes — a recognisable stand-in for the
 *  brand mark lucide does not ship. */
export function ClaudeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2.2c.35 0 .64.28.66.63l.28 4.02 2.2-3.38c.19-.3.58-.38.87-.19.28.19.36.57.19.86l-2.02 3.5 3.5-2.02c.3-.17.68-.09.87.19.19.29.11.68-.19.87l-3.38 2.2 4.02.28c.35.02.63.31.63.66s-.28.64-.63.66l-4.02.28 3.38 2.2c.3.19.38.58.19.87-.19.28-.57.36-.86.19l-3.5-2.02 2.02 3.5c.17.3.09.68-.19.87-.29.19-.68.11-.87-.19l-2.2-3.38-.28 4.02c-.02.35-.31.63-.66.63s-.64-.28-.66-.63l-.28-4.02-2.2 3.38c-.19.3-.58.38-.87.19-.28-.19-.36-.57-.19-.86l2.02-3.5-3.5 2.02c-.3.17-.68.09-.86-.19-.19-.29-.11-.68.19-.87l3.38-2.2-4.02-.28A.66.66 0 0 1 2.2 12c0-.35.28-.64.63-.66l4.02-.28-3.38-2.2c-.3-.19-.38-.58-.19-.87.18-.28.56-.36.86-.19l3.5 2.02-2.02-3.5c-.17-.29-.09-.67.19-.86.29-.19.68-.11.87.19l2.2 3.38.28-4.02c.02-.35.31-.63.66-.63z" />
    </svg>
  )
}
