import { describe, expect, it } from 'vitest'

import { canonicalLang, highlight, highlightSync, isPlainLang, supportedLanguages } from './highlighter'

/**
 * The Shiki singleton, exercised for real: the JS regex engine is pure JS, so jsdom runs the
 * actual highlighter — no stubbing. The first `highlight` call cold-boots the core through the
 * same dynamic imports the browser uses.
 *
 * Every test that asserts FULL tokenization passes `tokenizeTimeLimit: 0`: Shiki's per-line
 * budget is wall-clock (default 500ms), and under full-suite parallelism the cold TS grammar's
 * lazy regex compilation can exceed it on a contended CPU — Shiki then stops mid-line and the
 * tail comes back plain, failing the color assertions on a machine-load coin flip. Disabling
 * the budget makes deterministic input → deterministic output; the app path keeps the default
 * on purpose (degrading a pathological line beats wedging the main thread).
 */
const NO_BUDGET = { tokenizeTimeLimit: 0 }

describe('highlighter singleton', () => {
  it('maps fence aliases onto the grammar allowlist, and unknown infos onto null', () => {
    expect(canonicalLang('ts')).toBe('typescript')
    expect(canonicalLang('TS')).toBe('typescript')
    expect(canonicalLang('bash')).toBe('shellscript')
    expect(canonicalLang('sh')).toBe('shellscript')
    expect(canonicalLang('python')).toBe('python')
    expect(canonicalLang('toml')).toBe('toml') // agent config files (Codex config.toml)
    expect(canonicalLang('wat-is-this')).toBeNull()
    expect(isPlainLang('')).toBe(true)
    expect(isPlainLang('plaintext')).toBe(true)
    expect(isPlainLang('ts')).toBe(false)
  })

  it('answers unknown fence languages synchronously with plaintext — never a crash', () => {
    const result = highlightSync('hello <world>', 'not-a-language')
    expect(result).toEqual({
      tokens: [[{ content: 'hello <world>' }]],
      fg: 'var(--syn-var)',
      bg: 'transparent',
    })
  })

  it('highlights TypeScript through the CSS-variable theme — colors are var(--syn-*), never hex', async () => {
    const result = await highlight('const x = "hi" // note', 'ts', NO_BUDGET)
    const tokens = result.tokens[0]!
    const colors = new Set(tokens.map((t) => t.color))
    expect(colors.has('var(--syn-key)')).toBe(true) // const
    expect(colors.has('var(--syn-str)')).toBe(true) // "hi"
    expect(colors.has('var(--syn-com)')).toBe(true) // the comment
    for (const color of colors) {
      expect(color).toMatch(/^var\(--syn-[a-z]+\)$/)
    }
    expect(result.bg).toBe('transparent')
  })

  it('is resident after the first load: the same language then highlights synchronously', async () => {
    await highlight('let a = 1', 'ts', NO_BUDGET)
    const sync = highlightSync('let b = 2', 'typescript', NO_BUDGET)
    expect(sync).not.toBeNull()
    expect(sync!.tokens[0]!.some((t) => t.color === 'var(--syn-key)')).toBe(true)
  })

  it('multi-line code keeps its line structure (heights are predictable pre-highlight)', async () => {
    const result = await highlight('const a = 1\nconst b = 2\n', 'ts', NO_BUDGET)
    expect(result.tokens).toHaveLength(3) // two lines + the trailing empty one
  })

  it('an exhausted per-line budget degrades to plain tokens — the valve reaches the engine', async () => {
    // A negative budget is already exceeded at the tokenizer's first wall-clock check
    // (vscode-textmate: `elapsedTime > timeLimit` with elapsed 0), so the line comes back
    // untokenized — deterministically, without actually burning 500ms. This is exactly what a
    // contended CPU does to real code, proven here so the degrade path is a fact, not a guess.
    const result = await highlight('const x = 1', 'ts', { tokenizeTimeLimit: -1 })
    const colors = new Set(result.tokens[0]!.map((t) => t.color))
    expect(colors.has('var(--syn-key)')).toBe(false) // `const` lost its keyword scope — plain
  })

  it('names every supported spelling exactly once each', () => {
    const langs = supportedLanguages()
    expect(langs).toContain('ts')
    expect(langs).toContain('typescript')
    expect(langs).toContain('plaintext')
    expect(new Set(langs).size).toBe(langs.length)
  })
})
