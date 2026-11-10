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

  it('yaml: the real parser accepts what omp writes and refuses what omp could not read', () => {
    // Valid full-YAML constructs a subset parser would refuse.
    expect(validateConfig('---\nmodelRoles:\n  default: openrouter/deepseek/deepseek-v4-flash\n', 'yaml').ok).toBe(true);
    expect(validateConfig('systemPrompt: |\n  Be terse.\n  Cite files.\nsetupVersion: 2\n', 'yaml').ok).toBe(true);
    expect(validateConfig('base: &b\n  x: 1\nderived:\n  <<: *b\n', 'yaml').ok).toBe(true);
    expect(validateConfig('providers:\n  - openrouter\n  - anthropic\n', 'yaml').ok).toBe(true);
    // Malformed syntax must not be written where omp would fail to read it.
    const unterminated = validateConfig('modelRoles:\n  default: "unterminated\n', 'yaml');
    expect(unterminated.ok).toBe(false);
    expect(unterminated.error).toBeTruthy();
    expect(validateConfig('a: 1\n b: 2\n', 'yaml').ok).toBe(false);
    expect(validateConfig('key: [1, 2\n', 'yaml').ok).toBe(false);
  });

  it('yaml: a well-formed document that is not a mapping is no config.yml', () => {
    // These parse fine, but `parseYamlMapping` would read each as `{}` — saving one would wipe
    // every setting while reporting success.
    const sequence = validateConfig('- a\n- b\n', 'yaml');
    expect(sequence.ok).toBe(false);
    expect(sequence.error).toMatch(/must be a mapping.*sequence/);
    expect(validateConfig('just a string\n', 'yaml').ok).toBe(false);
    expect(validateConfig('42\n', 'yaml').ok).toBe(false);
    expect(validateConfig('true\n', 'yaml').ok).toBe(false);
    // An empty document is a new file, like empty content.
    expect(validateConfig('---\n', 'yaml').ok).toBe(true);
    expect(validateConfig('# only a comment\n', 'yaml').ok).toBe(true);
  });

  it('plain json comments are rejected under strict json but ok under jsonc', () => {
    expect(validateConfig('{"a":1} // c', 'json').ok).toBe(false);
    expect(validateConfig('{"a":1} // c', 'jsonc').ok).toBe(true);
  });
});
