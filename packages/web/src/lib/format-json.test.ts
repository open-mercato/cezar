import { describe, expect, it } from 'vitest'

import { formatJson } from './format-json'

describe('formatJson', () => {
  it('re-indents a misaligned document with the file’s own indent', () => {
    const input = '{\n  "theme": "dark",\n  "permissions": {\n    "allow": ["Bash(git push:*)"]\n   },\n  "sandbox": {"x": []}}'
    expect(formatJson(input)).toBe(
      '{\n  "theme": "dark",\n  "permissions": {\n    "allow": [\n      "Bash(git push:*)"\n    ]\n  },\n  "sandbox": {\n    "x": []\n  }\n}',
    )
  })

  it('keeps tab indentation and a trailing newline', () => {
    expect(formatJson('{\n\t"a": {"b": 1}}\n')).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n')
  })

  it('keeps CRLF line endings', () => {
    expect(formatJson('{\r\n  "a": [1, 2]\r\n}\r\n')).toBe('{\r\n  "a": [\r\n    1,\r\n    2\r\n  ]\r\n}\r\n')
  })

  it('takes the smallest indent, not the first one', () => {
    expect(formatJson('{\n   "a": {\n  "b": 1}}')).toBe('{\n  "a": {\n    "b": 1\n  }\n}')
    expect(formatJson('{"a": {\n        "b": 1}, "c": [\n    2]}')).toBe(
      '{\n    "a": {\n        "b": 1\n    },\n    "c": [\n        2\n    ]\n}',
    )
  })

  it('copies values verbatim: big integers, escapes, structural chars inside strings', () => {
    const input = '{"n": 12345678901234567890, "s": "a\\"{,}:[]\\\\", "e": 1E+2}'
    expect(formatJson(input)).toBe(
      '{\n  "n": 12345678901234567890,\n  "s": "a\\"{,}:[]\\\\",\n  "e": 1E+2\n}',
    )
  })

  it('returns null for invalid or empty input so the caller saves it untouched', () => {
    expect(formatJson('{"a": 1,}')).toBeNull()
    expect(formatJson('// c\n{}')).toBeNull()
    expect(formatJson('  ')).toBeNull()
  })

  it('is idempotent', () => {
    const once = formatJson('{"a":[1,{"b":null}],"c":{}}')!
    expect(formatJson(once)).toBe(once)
  })
})
