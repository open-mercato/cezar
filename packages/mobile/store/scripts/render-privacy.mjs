#!/usr/bin/env node
// Renders store/privacy-policy.md to store/privacy-policy.html, one self-contained page to host at the
// privacy policy URL (RELEASING-MOBILE.md). Only the Markdown the policy uses: headings, paragraphs,
// lists, tables, **bold**, `code` and links. No dependency.
//
//   node store/scripts/render-privacy.mjs            draft: open facts are highlighted
//   node store/scripts/render-privacy.mjs --final    refuses while any [OPEN MERCATO TO CONFIRM: …] is left
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('../privacy-policy.md', import.meta.url);
const OUT = new URL('../privacy-policy.html', import.meta.url);
const OPEN = /\[OPEN MERCATO TO CONFIRM:[^\]]*\]/g;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(OPEN, (m) => `<mark class="open">${m}</mark>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https:\/\/[^\s)<]+[^\s)<.,])/g, '$1<a href="$2">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

export function render(md) {
  const out = [];
  const lines = md.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${h[1].length} id="${id}">${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const [head, , ...body] = rows;
      out.push('<table><thead><tr>' + cells(head).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + cells(r).map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^(- |  \S)/.test(lines[i])) {
        if (lines[i].startsWith('- ')) items.push(lines[i].slice(2));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^---+$/.test(line)) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||- |---)/.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

export function page(md, { final }) {
  const open = md.match(OPEN) ?? [];
  if (final && open.length) throw new Error(`${open.length} fact(s) still marked OPEN MERCATO TO CONFIRM`);
  const title = /^# (.*)$/m.exec(md)?.[1] ?? 'Privacy policy';
  const banner = open.length
    ? `<p class="banner">Draft: ${open.length} highlighted fact(s) must be filled in before this page is published.</p>\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --bg: #fff; --muted: #555; --line: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #111; --muted: #aaa; --line: #333; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.9rem; line-height: 1.2; } h2 { margin-top: 2.2em; font-size: 1.3rem; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .92rem; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  code { font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: inherit; }
  mark.open { background: #ffe58a; color: #111; }
  .banner { border: 2px solid #d4a000; padding: 10px 14px; }
</style>
</head>
<body>
<main>
${banner}${render(md)}
</main>
</body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const md = readFileSync(SRC, 'utf8');
    writeFileSync(OUT, page(md, { final: process.argv.includes('--final') }));
    console.log(`wrote ${OUT.pathname}`);
  } catch (err) {
    console.error(`render-privacy: ${err.message}`);
    process.exit(1);
  }
}
