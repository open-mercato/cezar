import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useMemo, useRef } from 'react'

import { cn } from '@/lib/utils'

/**
 * The Code view's editor (spec `2026-07-20-worktree-file-editing` §Revision 2026-10-10,
 * Decision 1): CodeMirror 6, where `code-editor.tsx` is a `<textarea>` over a token layer. That
 * overlay is right for a config file and wrong for source — no search, no indentation, no soft
 * wrap, plaintext past 1500 lines — which is the whole reason this exists.
 *
 * Imported ONLY through `lazy()`: this module and the grammars behind it are a chunk a cockpit
 * that never edits a file never downloads. Each language is its own chunk again, fetched when a
 * file of that kind is first opened (`@codemirror/language-data`).
 *
 * Colors are the cockpit's own: the surface reads the design tokens and syntax reads the same
 * `--syn-*` variables Shiki paints the preview with, so view mode and edit mode agree and a
 * theme switch repaints both with no work here.
 */

/** Marks a transaction that mirrors the `value` prop, so it is not reported back as an edit. */
const External = Annotation.define<boolean>()

const syntax = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.self, t.definitionKeyword], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-str)' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName, t.tagName, t.attributeName, t.namespace],
    color: 'var(--syn-fn)',
  },
  { tag: [t.comment, t.meta], color: 'var(--syn-com)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.escape], color: 'var(--syn-num)' },
  { tag: [t.punctuation, t.operator, t.bracket, t.separator], color: 'var(--syn-punc)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--syn-var)' },
  { tag: t.heading, color: 'var(--syn-key)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--syn-fn)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--danger)' },
])

const tint = (token: string, percent: number) => `color-mix(in oklab, var(${token}) ${percent}%, transparent)`

const surface = EditorView.theme({
  '&': { height: '100%', color: 'var(--syn-var)', backgroundColor: 'transparent', fontSize: '0.75rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
  '.cm-content': { caretColor: 'var(--foreground)', padding: '0.5rem 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--soft-foreground)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.75rem 0 1rem', minWidth: '2.5rem' },
  '.cm-activeLine': { backgroundColor: tint('--muted', 55) },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: tint('--primary', 30),
  },
  '.cm-selectionMatch': { backgroundColor: tint('--primary', 14) },
  '.cm-searchMatch': { backgroundColor: tint('--primary', 22), outline: `1px solid ${tint('--primary', 55)}` },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: tint('--primary', 45) },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: tint('--primary', 25), outline: 'none' },
  // The find panel is CodeMirror's own DOM; without these it paints its stock light-grey chrome.
  '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '0.75rem', padding: '0.375rem 0.75rem' },
  '.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: 'inherit' },
  '.cm-textfield': {
    backgroundColor: 'var(--card)',
    border: '1px solid var(--input)',
    borderRadius: '0.375rem',
    color: 'inherit',
    fontSize: 'inherit',
    padding: '0.125rem 0.375rem',
  },
  '.cm-textfield:focus-visible': { outline: '2px solid var(--ring)', outlineOffset: '-1px' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--card)',
    border: '1px solid var(--input)',
    borderRadius: '0.375rem',
    color: 'inherit',
    fontSize: 'inherit',
    padding: '0.125rem 0.5rem',
  },
  '.cm-panel.cm-search [name=close]': { color: 'var(--soft-foreground)', fontSize: '1rem' },
})

/**
 * The separator this file is joined with on the way back out. CodeMirror otherwise splits on any
 * of `\n` / `\r\n` / `\r` and joins with `\n`, which rewrites every line of a CRLF file on the
 * first save — the server promises bytes verbatim, so the editor must not normalize them first.
 * A file that is CRLF throughout keeps `\r\n`; anything else is split on `\n` alone, which leaves
 * a stray `\r` in the text where it was rather than deciding what the file "meant".
 */
function lineSeparatorOf(text: string): string {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text) ? '\r\n' : '\n'
}

export interface CodeMirrorEditorProps {
  value: string
  onChange?: (next: string) => void
  /** The file's path — its NAME picks the grammar, the way the preview's `langForPath` does. */
  path: string
  readOnly?: boolean
  /** Soft-wrap long lines instead of scrolling sideways. */
  wrap?: boolean
  /** Bump to open the find panel — for a button, since Ctrl/Cmd+F only works with the editor
   *  focused, is taken by some embedding shells, and does not exist on a touch screen. */
  findRequest?: number
  className?: string
  'aria-label'?: string
}

export default function CodeMirrorEditor({
  value,
  onChange,
  path,
  readOnly = false,
  wrap = false,
  findRequest = 0,
  className,
  'aria-label': ariaLabel,
}: CodeMirrorEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Read through a ref: the listener is installed once, and must call whatever the parent passed
  // on its LATEST render — its closure carries the edit the next keystroke is merged into.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const slots = useMemo(() => ({ language: new Compartment(), readOnly: new Compartment(), wrap: new Compartment() }), [])

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorState.lineSeparator.of(lineSeparatorOf(value)),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          search({ top: true }),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          // Tab indents here — this is a code editor. Escape, then Tab, leaves it by keyboard
          // (CodeMirror's own escape hatch); the overlay editor in Settings still never traps it.
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          syntaxHighlighting(syntax),
          surface,
          slots.language.of([]),
          slots.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          slots.wrap.of(wrap ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (update.transactions.some((tr) => tr.annotation(External))) return
            onChangeRef.current?.(update.state.sliceDoc())
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Mounted once per file (the caller keys this component by path); every prop that can change
    // afterwards has its own effect below.
  }, [])

  // A `value` that is not what the editor holds came from outside — a reload from disk.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.sliceDoc()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: External.of(true),
    })
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: slots.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    })
  }, [readOnly, slots])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: slots.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap, slots])

  useEffect(() => {
    if (findRequest > 0 && viewRef.current) openSearchPanel(viewRef.current)
  }, [findRequest])

  // No grammar for this name is not an error: the file is plain text and exactly as editable.
  useEffect(() => {
    const description = LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf('/') + 1))
    if (!description) return
    let cancelled = false
    void description
      .load()
      .then((support) => {
        if (!cancelled) viewRef.current?.dispatch({ effects: slots.language.reconfigure(support) })
      })
      .catch(() => undefined) // a grammar chunk that failed to fetch leaves plain text, still editable
    return () => {
      cancelled = true
    }
  }, [path, slots])

  return <div ref={host} data-slot="code-mirror" className={cn('min-h-0 overflow-hidden', className)} />
}
