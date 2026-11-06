// Telegram text names commands (/status), routes (/api/v1/runs) and markup (</b>), so unlike
// webhook payloads a path starts only at a private root; its tail is still discarded.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A literal root ends at a separator, whitespace, a quote, punctuation or the end of the text.
const rootEnd = String.raw`(?=[\\/\s"'\x60.,;:!?)\]}]|$)`;
const fixedStarts = [String.raw`[Ff][Ii][Ll][Ee]:\/\/`, String.raw`[A-Za-z]:[\\/]`, String.raw`\\\\`, String.raw`~[A-Za-z0-9_.-]*[\\/]`,
  // A fixed root needs a segment after it: bare `/users` or `/home` is a route, not a file.
  String.raw`\/(?:home|Users|root|tmp|var\/folders|private\/var\/folders)[\\/]`];

function privatePath(roots: readonly string[]): RegExp {
  const literal = [...new Set(roots.map(root => root.replace(/[\\/]+$/, '')).filter(root => root.length > 1))]
    .sort((a, b) => b.length - a.length).map(root => `${escape(root)}${rootEnd}`);
  const start = `(?:${[...literal, ...fixedStarts].join('|')})`;
  // Unquoted paths can contain spaces: drop the rest of the line rather than expose a suffix.
  // Case-sensitive: `/users` is a route, `/Users` a macOS home (drive letters list both cases).
  return new RegExp(String.raw`(?<![\w/\\])(?:(["'\x60])${start}[^\r\n]*?\1|${start}[^\r\n]*)`, 'g');
}

/** Scrub local private paths from Telegram-bound text; HTTP(S) links are kept whole. */
export function scrubTelegramText(text: string, roots: readonly string[]): string {
  const path = privatePath(roots);
  // A URL token stops at quotes, brackets and commas, so a path glued to it is still scrubbed.
  return text.split(/(https?:\/\/[^\s"'\x60<>()[\]{},]+)/gi).map((part, index) => {
    if (index % 2) {
      try { if (new URL(part).hostname) return part; } catch { /* scrub malformed URLs as text */ }
    }
    return part.replace(path, match => `…${/[.,;:!?\])}]+$/.exec(match)?.[0] ?? ''}`);
  }).join('');
}
