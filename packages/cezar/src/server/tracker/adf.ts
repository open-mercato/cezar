/** Small ADF renderer: preserve readable context and explicitly mark every unsupported node. */
export function adfMarkdown(document: unknown): { body: string; unsupportedContent: boolean } {
  let unsupportedContent = false;
  let nodes = 0;
  const render = (value: unknown, depth = 0): string => {
    if (depth > 50 || ++nodes > 50_000) { unsupportedContent = true; return ''; }
    if (!value || typeof value !== 'object') { unsupportedContent = true; return ''; }
    const node = value as Record<string, unknown>;
    const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs as Record<string, unknown> : {};
    const children = Array.isArray(node.content) ? node.content : [];
    const content = () => children.map(child => render(child, depth + 1)).join('');
    switch (node.type) {
      case 'doc': return content().trim();
      case 'text': {
        let text = typeof node.text === 'string' ? node.text : '';
        for (const raw of Array.isArray(node.marks) ? node.marks : []) {
          if (!raw || typeof raw !== 'object') { unsupportedContent = true; continue; }
          const mark = raw as { type?: string; attrs?: { href?: string } };
          if (mark.type === 'strong') text = `**${text}**`;
          else if (mark.type === 'em') text = `*${text}*`;
          else if (mark.type === 'strike') text = `~~${text}~~`;
          else if (mark.type === 'code') text = `\`${text}\``;
          else if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && /^https?:\/\//i.test(mark.attrs.href)) text = `[${text}](${mark.attrs.href.replace(/[()\s]/g, encodeURIComponent)})`;
          else unsupportedContent = true;
        }
        return text;
      }
      case 'paragraph': return `${content()}\n\n`;
      case 'heading': return `${'#'.repeat(Math.max(1, Math.min(6, Number(attrs.level) || 1)))} ${content()}\n\n`;
      case 'hardBreak': return '\n';
      case 'rule': return '\n---\n\n';
      case 'codeBlock': {
        const text = content().trimEnd();
        const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
        return `${fence}${String(attrs.language ?? '').replace(/[^a-zA-Z0-9_+-]/g, '')}\n${text}\n${fence}\n\n`;
      }
      case 'blockquote': return content().trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
      case 'bulletList': case 'orderedList': return children.map((child, index) => {
        const marker = node.type === 'bulletList' ? '- ' : `${(Number(attrs.order) || 1) + index}. `;
        return marker + render(child, depth + 1).trim().replace(/\n/g, '\n  ');
      }).join('\n') + '\n\n';
      case 'listItem': return content();
      case 'table': {
        const rows = children.map(child => render(child, depth + 1).trim());
        const first = children[0] as { content?: unknown[] } | undefined;
        if (rows.length) rows.splice(1, 0, '| ' + (first?.content ?? []).map(() => '---').join(' | ') + ' |');
        return rows.join('\n') + '\n\n';
      }
      case 'tableRow': return '| ' + children.map(child => render(child, depth + 1).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |\n';
      case 'tableCell': case 'tableHeader': return content();
      default: {
        unsupportedContent = true;
        const readable = [attrs.text, attrs.url, attrs.shortName].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
        return content() || readable || '[Unsupported content]';
      }
    }
  };
  return document == null ? { body: '', unsupportedContent: false } : { body: render(document), unsupportedContent };
}

export function descriptionBody(body: string, maximum: number, unsupportedContent = false): { body: string; bodyTruncated: boolean; unsupportedContent: boolean } {
  return { body: body.slice(0, maximum), bodyTruncated: body.length > maximum, unsupportedContent };
}
