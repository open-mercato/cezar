import { describe, expect, it } from 'vitest';
import { adfMarkdown, descriptionBody } from './adf.ts';

describe('Jira context conversion', () => {
  it('preserves code, headings, tables, links and nested lists', () => {
    const text = (s: string) => ({ type: 'text', text: s });
    const converted = adfMarkdown({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [text('Acceptance')] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const x = 1;')] },
      { type: 'paragraph', content: [{ ...text('source'), marks: [{ type: 'link', attrs: { href: 'https://example.test' } }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('required')] }] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [text('Key')] }, { type: 'tableHeader', content: [text('Value')] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [text('a')] }, { type: 'tableCell', content: [text('b')] }] }] },
    ] });
    expect(converted.unsupportedContent).toBe(false);
    expect(converted.body).toContain('## Acceptance');
    expect(converted.body).toContain('```ts\nconst x = 1;\n```');
    expect(converted.body).toContain('[source](https://example.test)');
    expect(converted.body).toContain('- required');
    expect(converted.body).toContain('| Key | Value |');
    expect(converted.body).toContain('| --- | --- |');
  });
  it('escapes a pipe in a table cell without letting a preceding backslash re-open it', () => {
    const cell = (s: string) => ({ type: 'tableCell', content: [{ type: 'text', text: s }] });
    const row = (...cells: string[]) => ({ type: 'tableRow', content: cells.map(cell) });
    const { body } = adfMarkdown({ type: 'doc', content: [{ type: 'table', content: [
      row('Key', 'Value'),
      row('a|b', String.raw`c\|d`),
      row(String.raw`C:\dir`, String.raw`e\\|`),
    ] }] });
    const rows = body.trim().split('\n');
    expect(rows[2]).toBe(String.raw`| a\|b | c\\\|d |`);
    // A backslash away from any pipe is left alone, so `C:\dir` keeps its literal text in code.
    expect(rows[3]).toBe(String.raw`| C:\dir | e\\\\\| |`);
    // GFM's cell split: a pipe is a delimiter only after an EVEN run of backslashes.
    const columns = (line: string) => line.slice(1, -1).split(/(?<=(?:^|[^\\])(?:\\\\)*)\|/).length;
    for (const line of rows) expect(columns(line)).toBe(2);
  });
  // The escape itself must not become the next ReDoS: `/(\\*)\|/g` re-scanned the whole run from
  // every position inside it, so a hostile cell of 64k backslashes held the event loop ~3.9 s.
  it('escapes a cell of nothing but backslashes in linear time', () => {
    const cell = (s: string) => ({ type: 'tableCell', content: [{ type: 'text', text: s }] });
    const document = { type: 'doc', content: [{ type: 'table', content: [
      { type: 'tableRow', content: [cell('\\'.repeat(64_000))] },
    ] }] };
    const started = performance.now();
    const { body } = adfMarkdown(document);
    expect(performance.now() - started).toBeLessThan(1000);
    // Untouched: not one of those backslashes stands in front of a pipe.
    expect(body).toContain('| ' + '\\'.repeat(64_000) + ' |');
  });
  it('flags unsupported nodes and marks while retaining readable text', () => {
    const result = adfMarkdown({ type: 'doc', content: [{ type: 'unknown', content: [{ type: 'text', text: 'keep this', marks: [null, { type: 'unknown' }] }] }, { type: 'media', attrs: { id: 'private' } }] });
    expect(result.unsupportedContent).toBe(true);
    expect(result.body).toContain('keep this');
  });
  it('retains attribute-only links and emoji while disclosing unsupported content', () => {
    const result = adfMarkdown({ type: 'doc', content: [{ type: 'inlineCard', attrs: { url: 'https://example.test/requirements' } }, { type: 'emoji', attrs: { shortName: ':warning:' } }] });
    expect(result.unsupportedContent).toBe(true);
    expect(result.body).toContain('https://example.test/requirements');
    expect(result.body).toContain(':warning:');
  });
  it('keeps requirements beyond the preview length in detail, flags actual loss', () => {
    const body = 'x'.repeat(8000) + 'ACCEPTANCE';
    expect(descriptionBody(body, 8000)).toMatchObject({ bodyTruncated: true });
    expect(descriptionBody(body, 60000)).toMatchObject({ body, bodyTruncated: false });
    expect(descriptionBody('x'.repeat(60001), 60000)).toMatchObject({ bodyTruncated: true });
    expect(adfMarkdown(null)).toEqual({ body: '', unsupportedContent: false });
  });
});
