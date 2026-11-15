/**
 * Re-indent a JSON document, touching whitespace only: every string, number and literal is copied
 * byte-for-byte (no JSON.parse round-trip), so big integers, escapes, key order and duplicate keys
 * survive. Returns `null` when the text is not valid JSON, so the caller saves it as typed and the
 * server's own validation reports the error.
 */
export function formatJson(text: string): string | null {
  if (text.trim() === '') return null
  try {
    JSON.parse(text)
  } catch {
    return null
  }
  const unit = detectIndent(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n' // a CRLF file must not flip every line in git
  let out = ''
  let depth = 0
  const newline = () => eol + unit.repeat(depth)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']'
      const next = nextNonSpace(text, i + 1)
      if (text[next] === close) {
        out += ch + close
        i = next
      } else {
        depth++
        out += ch + newline()
      }
    } else if (ch === '}' || ch === ']') {
      depth--
      out += newline() + ch
    } else if (ch === ',') {
      out += ',' + newline()
    } else if (ch === ':') {
      out += ': '
    } else if (!/\s/.test(ch)) {
      out += ch
    }
  }
  return out + (text.endsWith('\n') ? eol : '')
}

function nextNonSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text[i]!)) i++
  return i
}

/**
 * Keep the file's own indent unit: tabs if it indents with tabs, else the SMALLEST space indent
 * (a misaligned or nested first line must not lock in an odd unit), defaulting to two spaces.
 */
function detectIndent(text: string): string {
  const indents = [...text.matchAll(/\n([ \t]+)\S/g)].map((m) => m[1]!)
  if (indents.length === 0) return '  '
  if (indents[0]!.startsWith('\t')) return '\t'
  return ' '.repeat(Math.min(Math.min(...indents.map((s) => s.length)), 8))
}
