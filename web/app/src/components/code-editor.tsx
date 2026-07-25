import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { canonicalLang, highlight, highlightSync, type SynToken } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

/**
 * A raw, syntax-highlighted text editor: a transparent-text `<textarea>` over a
 * `<pre>` of Shiki tokens, sharing exact font metrics so the caret lands on the
 * glyph beneath it. No editor library — it reuses the highlighter singleton the
 * rest of the cockpit already uses for read-only rendering.
 *
 * Deliberate constraints (spec #404 §Editor): no soft wrap (horizontal scroll —
 * wrapping is what breaks overlay alignment, and config files want it anyway);
 * plaintext past a line cap; Tab is NOT trapped (keyboard nav must keep working);
 * language comes from the caller (the catalog knows the format), not a path guess.
 */

/** Past this many lines, skip highlighting — plaintext beats jank (matches the diff/file-preview cap). */
const HIGHLIGHT_MAX_LINES = 1500

/** Tokens for the whole text through the shared singleton: sync when the grammar is resident,
 *  async-load once otherwise, plaintext for unknown/oversized. Mirrors file-preview's useFileTokens. */
function useCodeTokens(text: string, lang: string): SynToken[][] {
  const plain = useMemo(() => text.split('\n').map((line) => [{ content: line }]), [text])
  const canonical = useMemo(() => canonicalLang(lang), [lang])
  const oversized = plain.length > HIGHLIGHT_MAX_LINES
  const [loaded, setLoaded] = useState<{ key: string; tokens: SynToken[][] } | null>(null)

  useEffect(() => {
    if (canonical === null || oversized) return
    let cancelled = false
    void highlight(text, canonical).then((result) => {
      if (!cancelled) setLoaded({ key: text, tokens: result.tokens })
    })
    return () => {
      cancelled = true
    }
  }, [text, canonical, oversized])

  if (canonical === null || oversized) return plain
  if (loaded?.key === text) return loaded.tokens
  return highlightSync(text, canonical)?.tokens ?? plain
}

export interface CodeEditorProps {
  value: string
  onChange?: (next: string) => void
  /** Highlighter fence language (the catalog's `format`: json | jsonc | toml | markdown). */
  language: string
  readOnly?: boolean
  className?: string
  'aria-label'?: string
}

/** Shared layout so the textarea and the highlighted underlay align to the pixel. */
const SURFACE =
  'm-0 min-h-full w-full whitespace-pre font-mono text-xs leading-[1.7] px-3 py-2 [tab-size:2]'

export function CodeEditor({ value, onChange, language, readOnly, className, ...aria }: CodeEditorProps) {
  const tokens = useCodeTokens(value, language)
  const preRef = useRef<HTMLPreElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Keep the underlay scrolled in lockstep with the textarea (the scroller).
  const syncScroll = () => {
    const ta = taRef.current
    const pre = preRef.current
    if (!ta || !pre) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  }
  useLayoutEffect(syncScroll, [value])

  return (
    <div
      data-slot="code-editor"
      className={cn('relative overflow-hidden rounded-md border border-input bg-card', className)}
    >
      <pre
        ref={preRef}
        aria-hidden="true"
        className={cn(SURFACE, 'pointer-events-none absolute inset-0 overflow-auto text-soft-foreground')}
      >
        {tokens.map((line, i) => (
          <span key={i} className="block">
            {line.length === 0 ? (
              '\n'
            ) : (
              <>
                {line.map((token, j) => (
                  <span key={j} style={token.color !== undefined ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))}
                {'\n'}
              </>
            )}
          </span>
        ))}
      </pre>
      <textarea
        ref={taRef}
        data-slot="code-editor-input"
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        wrap="off"
        className={cn(
          SURFACE,
          'relative block resize-none overflow-auto bg-transparent text-transparent caret-foreground outline-none',
          'selection:bg-primary/30 focus-visible:ring-0',
          readOnly && 'cursor-default',
        )}
        {...aria}
      />
    </div>
  )
}
