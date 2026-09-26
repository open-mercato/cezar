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
