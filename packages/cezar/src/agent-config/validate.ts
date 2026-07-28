import { parse as parseToml } from 'smol-toml';
import type { ConfigFormat } from './catalog.js';

/**
 * On save, cezar proves a config file PARSES in its own format — refusing to
 * write bytes that would break the user's agent — but it never checks the
 * vendor's *schema* (that is the drift a raw editor exists to avoid) and it
 * never re-serializes: a valid file is written back byte-for-byte as typed.
 */

export interface ValidationResult {
  ok: boolean;
  /** Human-readable parser message when `ok` is false. */
  error?: string;
}

/**
 * Strip `//` line and slash-star block comments from JSONC, string-aware so a
 * `//` or `/*` inside a JSON string is preserved. Whitespace-preserving (spans
 * are blanked, not removed) so parser error offsets still line up with the
 * source. Only used to validate — the original bytes are what gets written.
 */
export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && input[i + 1] === '/') {
      // Line comment runs to EOL; nothing follows it on the line, so dropping the
      // body doesn't shift any later token — only the newline must be preserved.
      while (i < input.length && input[i] !== '\n') i++;
      out += input[i] === '\n' ? '\n' : '';
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      out += '  '; // the opening `/*`, blanked in place so same-line offsets after it hold
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i++; // land on the closing '/'
      out += '  '; // the closing `*/`
      continue;
    }
    out += ch;
  }
  return out;
}

/** Validate `content` against `format`. Markdown is always valid; empty is always valid (a new file). */
export function validateConfig(content: string, format: ConfigFormat): ValidationResult {
  if (format === 'markdown') return { ok: true };
  if (content.trim() === '') return { ok: true };
  try {
    switch (format) {
      case 'json':
        JSON.parse(content);
        return { ok: true };
      case 'jsonc':
        JSON.parse(stripJsonComments(content));
        return { ok: true };
      case 'toml':
        parseToml(content);
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}
