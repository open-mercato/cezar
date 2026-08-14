import { describe, expect, it } from 'vitest';
import { stripJsonComments, validateConfig } from './validate.ts';

describe('stripJsonComments', () => {
  it('removes line and block comments', () => {
    expect(JSON.parse(stripJsonComments('{"a":1} // trailing'))).toEqual({ a: 1 });
    expect(JSON.parse(stripJsonComments('{/* head */ "a": 1}'))).toEqual({ a: 1 });
  });

  it('preserves // and /* inside strings', () => {
    const src = '{"url": "https://x.example/a", "glob": "/*.ts"}';
    expect(JSON.parse(stripJsonComments(src))).toEqual({ url: 'https://x.example/a', glob: '/*.ts' });
  });

  it('handles escaped quotes inside strings', () => {
    const src = '{"s": "a \\" // not a comment"}';
    expect(JSON.parse(stripJsonComments(src))).toEqual({ s: 'a " // not a comment' });
  });

  it('preserves newlines so error offsets line up', () => {
    expect(stripJsonComments('{\n// c\n}')).toBe('{\n\n}');
  });

  it('preserves byte length across a block comment (offsets after it hold)', () => {
    const src = '{/* hi */"a":1}';
    const out = stripJsonComments(src);
    expect(out.length).toBe(src.length);
    // the token after the comment sits at the same index in source and stripped output
    expect(out.indexOf('"a"')).toBe(src.indexOf('"a"'));
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });
});

describe('validateConfig', () => {
  it('markdown and empty are always valid', () => {
    expect(validateConfig('# anything at all', 'markdown').ok).toBe(true);
    expect(validateConfig('', 'json').ok).toBe(true);
    expect(validateConfig('   \n', 'toml').ok).toBe(true);
  });

  it('accepts good json / jsonc / toml', () => {
    expect(validateConfig('{"a":1}', 'json').ok).toBe(true);
    expect(validateConfig('{"a":1} // ok', 'jsonc').ok).toBe(true);
    expect(validateConfig('[mcp_servers.x]\ncommand = "node"', 'toml').ok).toBe(true);
  });

  it('rejects broken json / toml with a message', () => {
    const bad = validateConfig('{"a": }', 'json');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
    expect(validateConfig('key = = 1', 'toml').ok).toBe(false);
  });

  it('plain json comments are rejected under strict json but ok under jsonc', () => {
    expect(validateConfig('{"a":1} // c', 'json').ok).toBe(false);
    expect(validateConfig('{"a":1} // c', 'jsonc').ok).toBe(true);
  });
});
