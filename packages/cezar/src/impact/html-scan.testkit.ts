/**
 * A minimal HTML tokenizer for the impact tests — the role Python's `HTMLParser` plays in
 * `test_cockpit.py`. It follows the parsing rules that matter for injection: comments are skipped,
 * and a `<script>`'s content is raw text that only `</script` ends.
 */
export interface ScannedTag {
  tag: string;
  attrs: Record<string, string>;
}

export interface ScannedDocument {
  tags: ScannedTag[];
  ids: string[];
  scripts: string[];
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function scanHtml(html: string): ScannedDocument {
  const doc: ScannedDocument = { tags: [], ids: [], scripts: [] };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const open = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt, lt + 64));
    if (!open || !open[1]) {
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const tag = open[1].toLowerCase();
    const attrText = html.slice(lt + 1 + open[1].length, gt);
    const attrs: Record<string, string> = {};
    for (const m of attrText.matchAll(ATTR)) {
      const name = m[1]?.toLowerCase();
      if (name) attrs[name] = decode(m[2] ?? m[3] ?? m[4] ?? '');
    }
    doc.tags.push({ tag, attrs });
    if (attrs.id !== undefined) doc.ids.push(attrs.id);
    i = gt + 1;
    if (tag === 'script') {
      const close = html.toLowerCase().indexOf('</script', i);
      const end = close < 0 ? html.length : close;
      doc.scripts.push(html.slice(i, end));
      i = end;
    }
  }
  return doc;
}
