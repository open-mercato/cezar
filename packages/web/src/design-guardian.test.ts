import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Design guardian — a static scan enforcing the spec's design-system rules over the cockpit
 * sources (ported from mercato's guardian). It runs inside `npm test`, so a violation fails
 * the validation gate with the exact file, line, and offending token.
 *
 * Scope:
 *  - "style" rules scan shipped UI sources (`src/**` minus `*.test.*`) — tests legitimately
 *    quote forbidden tokens when asserting user-visible copy (a PR chip's `#402`) or when
 *    asserting a rule holds (`expect(...).not.toContain('h-screen')`).
 *  - "code" rules (native dialogs) scan everything that executes: `src/**` and `e2e/**`,
 *    tests included.
 *  - Comments are stripped before matching (issue references like `#377` share the hex-color
 *    grammar), with string awareness so a `//` inside a URL literal is not treated as one.
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.basename(fileURLToPath(import.meta.url))

interface SourceFile {
  /** Path relative to packages/web, always with `/` separators (allowlists match on it). */
  rel: string
  ext: string
  isTest: boolean
  isE2e: boolean
  /** Comment-stripped source; stripping preserves line numbers and column positions. */
  lines: string[]
}

interface Rule {
  name: string
  why: string
  pattern: RegExp
  applies: (file: SourceFile) => boolean
  /** Files where the token is legitimate (the token definition site, primitives). */
  allowed?: (rel: string) => boolean
}

/** Shipped UI code and stylesheets — where the design tokens are the only color vocabulary. */
const styleSources = (f: SourceFile) => !f.isTest && !f.isE2e
/** Everything that executes in or against the app, tests and e2e drivers included. */
const codeSources = (f: SourceFile) => f.ext !== '.css'

const RULES: Rule[] = [
  {
    name: 'no-raw-hex-colors',
    why: 'colors go through the design tokens in src/styles/index.css, never raw hex',
    // 3/4/6/8-digit hex only (the CSS color grammar); the lookarounds reject HTML entities
    // (`&#8203;`) and longer hashes, and comment stripping removes issue refs like `#402`.
    pattern: /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
    applies: styleSources,
    allowed: (rel) => rel === 'src/styles/index.css',
  },
  {
    name: 'no-amber-text',
    why: 'amber ink goes through --pending-strong, the per-theme readable token; --pending itself is a dot & spinner FILL and fails contrast as text on the light theme (token sheet rule)',
    // `text-pending-strong` is excluded by the lookahead — it is the sanctioned spelling, and it
    // is a different token, not a loophole: `--pending` is amber-400 in both themes, while
    // `--pending-strong` darkens to amber-700 on light. Everything else amber stays banned.
    pattern: /\btext-(?:pending(?!-strong)|amber(?:-\d+)?)\b/g,
    applies: styleSources,
  },
  {
    name: 'no-raw-black-white',
    why: 'use surface/foreground tokens so both themes work; bg/text-white/black bypass them',
    pattern: /\b(?:bg|text)-(?:white|black)\b/g,
    applies: styleSources,
    // The shadcn overlay scrims (dialog, sheet) and the image lightbox scrim are deliberately
    // bg-black/xx in both themes — a dark backdrop is theme-agnostic by design.
    allowed: (rel) =>
      rel.startsWith('src/components/ui/') || rel === 'src/components/zoomable-image.tsx',
  },
  {
    name: 'no-native-dialogs',
    why: 'native confirm()/alert()/prompt() block the event loop and ignore the design system',
    // Bare or window./globalThis.-qualified calls; `foo.confirm(` (someone's API) stays legal.
    pattern: /(?<![\w$.])(?:window\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/g,
    applies: codeSources,
    // The bookmarklet generator's `alert(` lives inside the javascript: PROGRAM STRING it
    // emits (spec 011, ported verbatim from web/app.js). That program runs on github.com,
    // where the cockpit's toaster does not exist — alert() is its only honest surface. The
    // cockpit's own code in that file never calls a native dialog.
    allowed: (rel) => rel === 'src/lib/bookmarklet.ts',
  },
  {
    name: 'no-dark-variant',
    why: 'theming keys off the [data-theme] tokens, not prefers-color-scheme dark: variants',
    // `dark:` immediately followed by a utility (letter, `[`, `!`, `-`, `/`) — an object
    // literal's `dark: value` key has whitespace after the colon and stays legal.
    pattern: /\bdark:(?=[a-z![/-])/g,
    applies: styleSources,
  },
  {
    name: 'fixture-serve-must-pin-cez-home',
    why: "a spec-owned `cezar serve` takes its env from fixtureServeEnv(dataRoot) — a hand-rolled { CEZ_DRY_RUN } leaves CEZ_HOME at the developer's real ~/.cezar, so every run appends a dead /tmp fixture to their project registry",
    // Line-level: a CEZ_DRY_RUN that is not accompanied by a CEZ_HOME on the same line. Both
    // fixtureServeEnv() and the specs that spell the pair inline satisfy it.
    pattern: /^(?![^\n]*CEZ_HOME)[^\n]*\bCEZ_DRY_RUN\b/g,
    applies: (f) => f.isE2e,
  },
  {
    name: 'no-100vh',
    why: 'viewport height is 100dvh/h-dvh — 100vh ignores mobile browser chrome (iOS rule)',
    pattern: /\b(?:(?:h|min-h|max-h)-screen|100vh)\b/g,
    applies: styleSources,
  },
]

/**
 * Blanks out comments while preserving the file's shape (every non-newline comment char
 * becomes a space). Tracks string state so comment openers inside literals are ignored.
 * Known limitation: regex literals are not lexed, so `/` pairs inside one can eat the rest
 * of a line — acceptable for a guardian (it can only under-report on that one line).
 */
function stripComments(source: string, lineComments: boolean): string {
  let out = ''
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const n = source[i + 1]
    if (mode === 'code') {
      if (lineComments && c === '/' && n === '/') {
        mode = 'line'
        out += '  '
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        mode = 'block'
        out += '  '
        i += 2
        continue
      }
      if (c === "'") mode = 'single'
      else if (c === '"') mode = 'double'
      else if (c === '`') mode = 'template'
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      } else {
        out += ' '
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        out += '  '
        i += 2
        continue
      }
      out += c === '\n' ? c : ' '
      i += 1
      continue
    }
    // String modes: honor escapes, close on the matching quote (or, for ' and ", a newline —
    // an unterminated string must not swallow the rest of the file).
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    if (
      (mode === 'single' && (c === "'" || c === '\n')) ||
      (mode === 'double' && (c === '"' || c === '\n')) ||
      (mode === 'template' && c === '`')
    ) {
      mode = 'code'
    }
    out += c
    i += 1
    continue
  }
  return out
}

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function loadSources(): SourceFile[] {
  const files: SourceFile[] = []
  for (const root of ['src', 'e2e']) {
    for (const abs of walk(path.join(APP_ROOT, root))) {
      const rel = path.relative(APP_ROOT, abs).split(path.sep).join('/')
      // This file defines the forbidden patterns as literals; scanning it would be circular.
      if (path.basename(rel) === SELF) continue
      const ext = path.extname(rel)
      const stripped = stripComments(readFileSync(abs, 'utf8'), ext !== '.css')
      files.push({
        rel,
        ext,
        isTest: /\.test\.(?:ts|tsx)$/.test(rel),
        isE2e: rel.startsWith('e2e/'),
        lines: stripped.split('\n'),
      })
    }
  }
  return files
}

const sources = loadSources()

describe('design guardian', () => {
  it('actually scans the codebase (guards against a broken walker)', () => {
    const rels = new Set(sources.map((f) => f.rel))
    expect(rels.has('src/app.tsx')).toBe(true)
    expect(rels.has('src/styles/index.css')).toBe(true)
    expect(rels.has('e2e/smoke.e2e.ts')).toBe(true)
    expect(sources.length).toBeGreaterThan(40)
  })

  for (const rule of RULES) {
    it(`${rule.name}: ${rule.why}`, () => {
      const violations: string[] = []
      for (const file of sources) {
        if (!rule.applies(file)) continue
        if (rule.allowed?.(file.rel)) continue
        file.lines.forEach((line, index) => {
          for (const match of line.matchAll(rule.pattern)) {
            violations.push(`packages/web/${file.rel}:${index + 1}  ${match[0].trim()}`)
          }
        })
      }
      expect(violations, `${rule.name} — ${rule.why}`).toEqual([])
    })
  }
})
