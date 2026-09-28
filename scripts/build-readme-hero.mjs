#!/usr/bin/env node
// Generates the README hero images: docs/hero/hero-{lang}-{light,dark}.svg
//
// Why an image at all: GitHub appends a permalink anchor (the chain octicon, permanently
// visible on touch devices) to *every* heading element, raw HTML included, and strips
// `<font>`, `<big>` and `style="font-size:…"`. A heading is therefore the only way to
// enlarge text in a README, and it always drags the icon along — so hero text that has to
// be bigger than body text has to be drawn.
//
// Every line is emitted with `textLength`, measured here from the width table below, so the
// rendered layout is identical whichever font a device picks for the stack and no line can
// ever overflow the box. Widths are Helvetica/Arial/Roboto-class averages in 1/1000 em;
// being a few per mil off only scales a line's glyph spacing imperceptibly.
//
// Usage: node scripts/build-readme-hero.mjs [--check]
//   --check  regenerate into memory and fail if the files on disk differ (CI-friendly)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs/hero')

// Box width in CSS px. Chosen so the image barely scales down on a phone (GitHub's README
// column is roughly 330 px there): the headline and description then render close to their
// intrinsic size on mobile instead of shrinking the way a 720 px banner would.
const WIDTH = 380
const PAD_X = 12
const MAX_LINE = WIDTH - PAD_X * 2

const HEADLINE = { size: 30, weight: 700, lineHeight: 38 }
const BODY = { size: 22, weight: 400, lineHeight: 31 }
const GAP = 18
const PAD_Y = 6

const FONT_LATIN =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const FONT_CJK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', " +
  "'Microsoft YaHei', 'Noto Sans CJK SC', Helvetica, Arial, sans-serif"

const THEMES = {
  light: { headline: '#1F2328', body: '#424A53' },
  dark: { headline: '#F0F6FC', body: '#9198A1' },
}

// Advance widths in 1/1000 em, regular weight. Bold is ~4% wider (BOLD_FACTOR).
const W = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667,
  T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278, ']': 278,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '×': 584, '·': 278, '’': 191,
}
const BOLD_FACTOR = 1.04
const CJK_WIDTH = 1000 // full-width forms, including 、。：，（）

const isCjk = (ch) => {
  const c = ch.codePointAt(0)
  return (
    (c >= 0x2e80 && c <= 0x9fff) || // radicals through CJK unified ideographs
    (c >= 0xf900 && c <= 0xfaff) || // compatibility ideographs
    (c >= 0xff00 && c <= 0xff65) || // full-width forms
    (c >= 0x3000 && c <= 0x303f) // CJK punctuation
  )
}

function measure(text, size, bold) {
  let units = 0
  for (const ch of text) {
    if (isCjk(ch)) units += CJK_WIDTH
    else units += (W[ch] ?? 556) * (bold ? BOLD_FACTOR : 1)
  }
  return (units / 1000) * size
}

// Line breaking. A Latin word is atomic and breaks at spaces; CJK has no spaces, so a break
// is allowed between any two full-width characters — except before closing punctuation,
// which must never open a line (a stray 、 or 。 at the start of a line is the giveaway of a
// naive wrapper).
const NO_BREAK_BEFORE = new Set(['。', '，', '、', '：', '；', '）', '」', '】', '！', '？', '.', ',', '!', '?'])

function tokenize(text) {
  const tokens = []
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === ' ') {
      tokens.push({ t: ' ', space: true })
    } else if (isCjk(ch)) {
      tokens.push({ t: ch, cjk: true })
    } else {
      let word = ch
      while (i + 1 < chars.length && chars[i + 1] !== ' ' && !isCjk(chars[i + 1])) {
        word += chars[++i]
      }
      tokens.push({ t: word })
    }
  }
  return tokens
}

// May a line break open with `tokens[i]`, given what precedes it?
function breakAllowedBefore(tokens, i) {
  if (i <= 0 || i >= tokens.length) return false
  const tok = tokens[i]
  if (tok.space) return true // break at a space, dropping it
  if (NO_BREAK_BEFORE.has(tok.t)) return false
  const prev = tokens[i - 1]
  if (prev.space) return true
  return tok.cjk || prev.cjk // CJK boundaries break; mid-Latin-word never does
}

const joinTokens = (toks) => toks.map((t) => t.t).join('').trim()

function wrap(text, size, bold, maxWidth) {
  const tokens = tokenize(text)
  const lines = []
  let start = 0 // index of the first token on the current line
  let end = 0 // exclusive end of the tokens placed so far

  while (end < tokens.length) {
    const candidate = joinTokens(tokens.slice(start, end + 1))
    if (measure(candidate, size, bold) <= maxWidth) {
      end++
      continue
    }
    // Overflow at `end`: walk back to the last position that may open a line.
    let brk = end
    while (brk > start && !breakAllowedBefore(tokens, brk)) brk--
    // Nothing legal to walk back to — break at the overflow, and never emit an empty line
    // (a single token wider than the box would otherwise spin here forever; the width
    // assertion in svg() is what catches that case).
    if (brk <= start) brk = Math.max(start + 1, end)
    lines.push(joinTokens(tokens.slice(start, brk)))
    start = tokens[brk]?.space ? brk + 1 : brk
    end = Math.max(start, brk)
  }
  if (start < tokens.length) lines.push(joinTokens(tokens.slice(start)))

  return deOrphan(
    lines.filter(Boolean),
    size,
    bold,
    maxWidth,
  )
}

// A last line holding one or two characters reads as a mistake. Pull words back onto it
// from the line above while that keeps both lines inside the box.
function deOrphan(lines, size, bold, maxWidth) {
  if (lines.length < 2) return lines
  const out = [...lines]
  for (let guard = 0; guard < 4; guard++) {
    const last = out[out.length - 1]
    if (measure(last, size, bold) > maxWidth * 0.35) break
    const prev = out[out.length - 2]
    const prevTokens = tokenize(prev)
    // Find the last legal break inside the previous line and move that tail down.
    let brk = prevTokens.length - 1
    while (brk > 0 && !breakAllowedBefore(prevTokens, brk)) brk--
    if (brk <= 0) break
    const head = joinTokens(prevTokens.slice(0, brk))
    const tail = joinTokens(prevTokens.slice(prevTokens[brk].space ? brk + 1 : brk))
    const glue = isCjk([...tail].at(-1) ?? '') || isCjk([...last][0] ?? '') ? '' : ' '
    const merged = tail + glue + last
    if (!head || measure(merged, size, bold) > maxWidth) break
    out[out.length - 2] = head
    out[out.length - 1] = merged
  }
  return out
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function svg({ headline, body, lang, theme }) {
  const cjk = [...headline].some(isCjk)
  const font = cjk ? FONT_CJK : FONT_LATIN
  const colors = THEMES[theme]

  const hLines = wrap(headline, HEADLINE.size, true, MAX_LINE)
  const bLines = wrap(body, BODY.size, false, MAX_LINE)

  const height =
    PAD_Y * 2 + hLines.length * HEADLINE.lineHeight + GAP + bLines.length * BODY.lineHeight

  const mid = WIDTH / 2
  const rows = []
  let y = PAD_Y
  for (const line of hLines) {
    const baseline = y + (HEADLINE.lineHeight + HEADLINE.size * 0.72) / 2
    rows.push(
      `    <text x="${mid}" y="${baseline.toFixed(1)}" textLength="${measure(line, HEADLINE.size, true).toFixed(1)}" ` +
        `lengthAdjust="spacingAndGlyphs" font-size="${HEADLINE.size}" font-weight="${HEADLINE.weight}" ` +
        `fill="${colors.headline}">${esc(line)}</text>`,
    )
    y += HEADLINE.lineHeight
  }
  y += GAP
  for (const line of bLines) {
    const baseline = y + (BODY.lineHeight + BODY.size * 0.72) / 2
    rows.push(
      `    <text x="${mid}" y="${baseline.toFixed(1)}" textLength="${measure(line, BODY.size, false).toFixed(1)}" ` +
        `lengthAdjust="spacingAndGlyphs" font-size="${BODY.size}" font-weight="${BODY.weight}" ` +
        `fill="${colors.body}">${esc(line)}</text>`,
    )
    y += BODY.lineHeight
  }

  const widest = Math.max(
    ...hLines.map((l) => measure(l, HEADLINE.size, true)),
    ...bLines.map((l) => measure(l, BODY.size, false)),
  )
  if (widest > MAX_LINE + 0.5) {
    throw new Error(`hero-${lang}-${theme}: a line is ${widest.toFixed(1)}px wide, box allows ${MAX_LINE}`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(headline)} ${esc(body)}">
  <title>${esc(headline)}</title>
  <g font-family="${font}" text-anchor="middle">
${rows.join('\n')}
  </g>
</svg>
`
}

// The copy. Single source of truth for the hero wording — the READMEs carry the same words
// in the image `alt`, so edit here and regenerate, then update the alt text to match.
const LANGS = [
  {
    lang: 'en',
    headline: 'Cezar - orchestrate hundreds of AI coding agents, 24/7.',
    body:
      'One control center for Claude Code, Codex, OpenCode and other coding agents. ' +
      'Run agents locally or on a VPS, automate multi-step workflows, and let them keep ' +
      "working while you're away.",
  },
  {
    lang: 'zh-CN',
    headline: 'Cezar：编排数百个 AI 编程智能体，7×24 小时不间断。',
    body:
      '一个面向 Claude Code、Codex、OpenCode 及其他编程智能体的控制台。' +
      '在本地或 VPS 上运行智能体，自动化多步骤工作流，并让它们在你离开时继续工作。',
  },
  {
    lang: 'zh-TW',
    headline: 'Cezar：協調數百個 AI 編碼代理，全天候 24/7。',
    body:
      '一個面向 Claude Code、Codex、OpenCode 及其他編碼代理的控制台。' +
      '在本機或 VPS 上執行代理，自動化多步驟工作流程，並讓它們在你離開時繼續工作。',
  },
]

const check = process.argv.includes('--check')
mkdirSync(OUT_DIR, { recursive: true })

let drift = 0
for (const entry of LANGS) {
  for (const theme of Object.keys(THEMES)) {
    const file = join(OUT_DIR, `hero-${entry.lang}-${theme}.svg`)
    const content = svg({ ...entry, theme })
    if (check) {
      let current = ''
      try {
        current = readFileSync(file, 'utf8')
      } catch {
        /* missing counts as drift */
      }
      if (current !== content) {
        console.error(`drift: ${file}`)
        drift++
      }
    } else {
      writeFileSync(file, content)
      console.log(`wrote ${file}`)
    }
  }
}

if (check) {
  if (drift) {
    console.error(`${drift} hero file(s) out of date — run: node scripts/build-readme-hero.mjs`)
    process.exit(1)
  }
  console.log('hero SVGs are up to date')
}
