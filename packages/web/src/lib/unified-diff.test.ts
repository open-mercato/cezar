import { describe, expect, it } from 'vitest'

import { diffTotals, parseUnifiedDiff } from './unified-diff'

const MULTI_FILE = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@',
  " import { boot } from './boot'",
  '-const port = 3000',
  '+const port = Number(process.env.PORT ?? 3000)',
  '+boot(port)',
  ' export {}',
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -10,2 +10,3 @@ ## Usage',
  ' Run it.',
  '+Now with a port.',
  ' Done.',
  '',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('splits a multi-file diff into per-file sections with counts and hunk lines', () => {
    const files = parseUnifiedDiff(MULTI_FILE)
    expect(files).toHaveLength(2)

    expect(files[0]).toMatchObject({
      path: 'src/app.ts',
      status: 'modified',
      binary: false,
      additions: 2,
      deletions: 1,
    })
    expect(files[0]!.lines[0]).toBe('@@ -1,4 +1,5 @@')
    expect(files[0]!.lines).toContain('+boot(port)')
    // Metadata (index/---/+++) never leaks into the renderable body.
    expect(files[0]!.lines.some((l) => l.startsWith('+++'))).toBe(false)

    expect(files[1]).toMatchObject({ path: 'README.md', additions: 1, deletions: 0 })
    expect(diffTotals(files)).toEqual({ files: 2, additions: 3, deletions: 1 })
  })

  it('reads renames: status, oldPath → path, including rename-only entries with no hunks', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/old/name.ts b/new/name.ts',
        'similarity index 100%',
        'rename from old/name.ts',
        'rename to new/name.ts',
        '',
      ].join('\n'),
    )
    expect(files).toEqual([
      {
        path: 'new/name.ts',
        oldPath: 'old/name.ts',
        status: 'renamed',
        binary: false,
        additions: 0,
        deletions: 0,
        lines: [],
      },
    ])
  })

  it('marks binary files and gives them no lines', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/logo.png b/logo.png',
        'index 5555555..6666666 100644',
        'Binary files a/logo.png and b/logo.png differ',
        '',
      ].join('\n'),
    )
    expect(files).toEqual([
      { path: 'logo.png', status: 'modified', binary: true, additions: 0, deletions: 0, lines: [] },
    ])
  })

  it('new and deleted files: status from the mode lines, deletions keep the a/ path', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/added.txt b/added.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/added.txt',
        '@@ -0,0 +1 @@',
        '+hello',
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
        '',
      ].join('\n'),
    )
    expect(files[0]).toMatchObject({ path: 'added.txt', status: 'added', additions: 1, deletions: 0 })
    expect(files[1]).toMatchObject({ path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 })
  })

  it('does not count the no-newline marker but keeps it renderable', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 })
    expect(files[0]!.lines).toContain('\\ No newline at end of file')
  })

  it('empty input parses to zero files', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('non-diff text (the server sentences, garbage) parses to zero files', () => {
    expect(parseUnifiedDiff('(no worktree — this task ran directly in the repo working tree)')).toEqual([])
    expect(parseUnifiedDiff('(diff failed: not a git repository)\nsome\nnoise')).toEqual([])
    expect(parseUnifiedDiff('+++ looks diffish but has no file header\n@@ nope @@')).toEqual([])
  })

  it('unquotes git-escaped paths', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git "a/with \\"quote\\".txt" "b/with \\"quote\\".txt"',
        '--- "a/with \\"quote\\".txt"',
        '+++ "b/with \\"quote\\".txt"',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
    )
    expect(files[0]!.path).toBe('with "quote".txt')
  })
})
