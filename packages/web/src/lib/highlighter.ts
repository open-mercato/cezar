import type { HighlighterCore } from 'shiki/core'

/**
 * The ONE Shiki highlighter for the whole cockpit (spec, "Task thread" tech picks;
 * `.ai/analysis/cockpit-ui-redesign/diff-highlight-tech.md` §1). The thread's markdown code
 * blocks consume it now; R5's diff views share it — a second `createHighlighterCore` call
 * anywhere is a bug (it would instantiate the engine and re-fetch grammars twice).
 *
 * Bundle rules this module exists to enforce:
 *  - fine-grained core only (`shiki/core`), never the full `shiki` bundle — the full bundle
 *    lands every grammar in `dist/`;
 *  - the JavaScript regex engine, never the Oniguruma WASM blob (~600 KB it doesn't need);
 *  - core, engine and every grammar load through dynamic `import()`, so all of Shiki lives in
 *    lazy chunks off the main bundle — a thread with no code block downloads none of it;
 *  - grammars load on demand per fence language, from the explicit allowlist below (a fully
 *    dynamic `import(\`@shikijs/langs/${lang}\`)` would chunk-split all ~200 grammars);
 *  - every unknown language falls back to plaintext — LLMs invent fence infos (```console,
 *    ```jsonc-with-comments), and an unknown tag must cost highlighting, not a crash.
 *
 * Theming: ONE theme whose token colors are the `--syn-*` CSS variables from
 * `styles/index.css`. The variables flip with the `.light` class (Option B dual theme — not
 * `light-dark()`, which follows `color-scheme` rather than our class), so code highlighted once
 * re-themes instantly with zero JS — the opencode pattern the research singled out.
 */

/** A highlighted line: what both the markdown code blocks and R5's diffs render. */
export interface SynToken {
  content: string
  /** A `var(--syn-*)` reference, or undefined for plaintext runs. */
  color?: string
}

export interface SynHighlight {
  tokens: SynToken[][]
  fg: string
  bg: string
}

/**
 * The TextMate theme over the `--syn-*` tokens. Scope→variable mapping follows the mockup's
 * hand-highlighted snippet (docs/mockups/thread.html): keywords/storage violet, strings green,
 * functions/types blue, comments gray, numbers red, punctuation/operators dim, plain text
 * near-foreground. `type: 'dark'` is nominal — the variables carry both palettes.
 */
export const SYN_THEME = {
  name: 'cezar-syn',
  type: 'dark' as const,
  fg: 'var(--syn-var)',
  bg: 'transparent',
  settings: [
    {
      scope: [
        'keyword',
        'storage',
        'constant.language',
        'variable.language',
        'entity.other.attribute-name',
        'support.type.property-name',
      ],
      settings: { foreground: 'var(--syn-key)' },
    },
    { scope: ['string', 'punctuation.definition.string'], settings: { foreground: 'var(--syn-str)' } },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'entity.name.tag',
        'entity.name.type',
        'entity.name.class',
        'support.class',
        'support.type',
      ],
      settings: { foreground: 'var(--syn-fn)' },
    },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--syn-com)' } },
    {
      scope: ['constant.numeric', 'constant.character', 'constant.other', 'support.constant', 'keyword.other.unit'],
      settings: { foreground: 'var(--syn-num)' },
    },
    {
      scope: ['punctuation', 'keyword.operator', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: 'var(--syn-punc)' },
    },
    { scope: ['variable', 'entity.name.variable'], settings: { foreground: 'var(--syn-var)' } },
  ],
}

/** The grammar allowlist: what agent transcripts actually fence, one lazy chunk each. */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  python: () => import('@shikijs/langs/python'),
  markdown: () => import('@shikijs/langs/markdown'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  diff: () => import('@shikijs/langs/diff'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
}

/** Fence spellings for the grammars above (what `@shikijs/langs` registers as aliases, spelled
 *  out so support can be answered without loading anything). */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  bash: 'shellscript',
  sh: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  console: 'shellscript',
  py: 'python',
  md: 'markdown',
  yml: 'yaml',
  golang: 'go',
  rs: 'rust',
  vue: 'html',
  xml: 'html',
}

/** Languages that mean "no grammar" — rendered as plaintext without touching Shiki at all. */
const PLAIN = new Set(['', 'plaintext', 'text', 'txt', 'plain'])

/** The canonical grammar id for a fence language, or null when we don't carry one. */
export function canonicalLang(lang: string): string | null {
  const key = lang.trim().toLowerCase()
  if (key in LANG_LOADERS) return key
  return ALIASES[key] ?? null
}

export function isPlainLang(lang: string): boolean {
  return PLAIN.has(lang.trim().toLowerCase())
}

/** Every fence spelling the singleton will highlight (canonical ids + aliases + plaintext). */
export function supportedLanguages(): string[] {
  return [...Object.keys(LANG_LOADERS), ...Object.keys(ALIASES), ...PLAIN].filter((l) => l !== '')
}

/** Extension → the highlighter's fence language, or null for "don't highlight". Shared by the
 *  diff facade's per-file tokens and the Files tab's preview (R5). */
export function langForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  const extra: Record<string, string> = { mts: 'typescript', cts: 'typescript', htm: 'html' }
  return canonicalLang(extra[ext] ?? ext)
}

// ---- singleton state --------------------------------------------------------------------------

let core: HighlighterCore | null = null
let corePromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>()
const langPromises = new Map<string, Promise<void>>()

/** Boot the core exactly once: `shiki/core` + the JS regex engine, both as lazy chunks. */
function ensureCore(): Promise<HighlighterCore> {
  corePromise ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    async ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) => {
      core = await createHighlighterCore({
        themes: [SYN_THEME],
        langs: [],
        // `forgiving`: a grammar rule the JS engine cannot compile degrades that rule to
        // plaintext instead of throwing — the documented safety valve for the no-WASM setup.
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })
      return core
    },
  )
  return corePromise
}

/** Load one grammar (idempotent). Resolves even on failure — failure means plaintext, not error. */
export function ensureLang(lang: string): Promise<void> {
  const canonical = canonicalLang(lang)
  if (canonical === null || loadedLangs.has(canonical)) return Promise.resolve()
  let pending = langPromises.get(canonical)
  if (!pending) {
    pending = ensureCore()
      .then(async (highlighter) => {
        await highlighter.loadLanguage((await LANG_LOADERS[canonical]!()) as never)
        loadedLangs.add(canonical)
      })
      .catch(() => {
        // A failed grammar fetch must not wedge the promise cache in a rejected state forever —
        // drop it so a later render can retry, and let the caller fall back to plaintext now.
        langPromises.delete(canonical)
      })
    langPromises.set(canonical, pending)
  }
  return pending
}

function plaintext(code: string): SynHighlight {
  return {
    tokens: code.split('\n').map((line) => [{ content: line }]),
    fg: 'var(--syn-var)',
    bg: 'transparent',
  }
}

export interface HighlightOptions {
  /**
   * Shiki's per-line wall-clock budget in milliseconds (its `tokenizeTimeLimit`, default 500;
   * `0` disables it). When a line's tokenization exceeds the budget — the JS regex engine
   * compiles grammar rules lazily DURING the first scan, so a cold grammar on a busy CPU can
   * eat it — Shiki stops mid-line and the rest of the line comes back as plain text.
   *
   * The app keeps the default: a pathological line degrading to plaintext beats a wedged main
   * thread. Tests that assert full tokenization of known-small inputs must pass `0`, because
   * their wall clock is shared with every parallel worker vitest spawned — under full-suite
   * load the budget trips on trivial lines and the assertion flakes.
   */
  tokenizeTimeLimit?: number
}

/**
 * Highlight synchronously when the core and grammar are already resident, else null.
 * Streaming markdown re-highlights the growing tail block on every chunk — after the first
 * async load this is the path every subsequent chunk takes.
 */
export function highlightSync(code: string, lang: string, options: HighlightOptions = {}): SynHighlight | null {
  if (isPlainLang(lang)) return plaintext(code)
  const canonical = canonicalLang(lang)
  if (canonical === null) return plaintext(code) // unknown fence info — honest plaintext, sync
  if (!core || !loadedLangs.has(canonical)) return null
  try {
    const result = core.codeToTokens(code, {
      lang: canonical as never,
      theme: SYN_THEME.name,
      tokenizeTimeLimit: options.tokenizeTimeLimit,
    })
    return {
      tokens: result.tokens.map((line) => line.map(({ content, color }) => ({ content, color }))),
      fg: result.fg ?? 'var(--syn-var)',
      bg: 'transparent',
    }
  } catch {
    return plaintext(code)
  }
}

/** Highlight, loading the core and the grammar on the way when needed. Never rejects. */
export async function highlight(code: string, lang: string, options: HighlightOptions = {}): Promise<SynHighlight> {
  const sync = highlightSync(code, lang, options)
  if (sync) return sync
  await ensureLang(lang)
  return highlightSync(code, lang, options) ?? plaintext(code)
}

/** Test seam: drop the singleton so a suite can assert cold-boot behavior. */
export function resetHighlighterForTests(): void {
  core = null
  corePromise = null
  loadedLangs.clear()
  langPromises.clear()
}
