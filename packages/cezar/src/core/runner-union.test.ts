import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';

/** Derived, not spelled: the guard's own copy of the tuple went stale the moment `gemini` joined
 *  it, which is how a hand-written runner list slipped through (config.ts `defaultModels`). */
const RUNNER_ALTERNATION = RUNNER_IDS.join('|');
const SUBSET_MARKER = 'runner-union: deliberate subset';
const ALLOWLIST = new Set([
  // The ONE place the tuple is spelled.
  'packages/contract/src/runners.ts',
  'packages/cezar/src/core/ui-events.ts',
  'packages/api-client/src/protocol/ui-events.ts',
]);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__fixtures__' || entry.name === 'node_modules') continue;
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(path);
    }
  }
  return files;
}

function runnerLiterals(line: string): string[] {
  return [...line.matchAll(new RegExp(`["'](${RUNNER_ALTERNATION})["']`, 'g'))].map((match) => match[1]!);
}

/**
 * A per-runner zod object spelled key by key (`claude: z.…`, `codex: z.…`) instead of
 * `perRunner(…)`. The quoted-literal scan above cannot see it — the keys are bare identifiers —
 * and it is the worst kind of drift: zod STRIPS unknown keys, so a runner missing from the list
 * is dropped on every parse without an error. Two or more runner keys with zod values inside one
 * `z.object({…})` is the signature.
 */
function handSpelledRunnerObjects(source: string): number[] {
  const lines: number[] = [];
  const opener = /z\s*\.\s*object\s*\(\s*\{/g;
  const runnerKey = new RegExp(`^\\s*(${RUNNER_ALTERNATION})\\s*:\\s*z\\s*\\.`, 'gm');
  for (const match of source.matchAll(opener)) {
    let depth = 1;
    let end = match.index! + match[0].length;
    while (end < source.length && depth > 0) {
      const char = source[end];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      end += 1;
    }
    const body = source.slice(match.index! + match[0].length, end - 1);
    const keys = new Set([...body.matchAll(runnerKey)].map((key) => key[1]));
    if (keys.size >= 2) lines.push(source.slice(0, match.index).split('\n').length);
  }
  return lines;
}

describe('runner union guard', () => {
  it('does not duplicate a multi-runner literal outside the two protocol mirrors', () => {
    const repoRoot = join(import.meta.dirname, '../../../..');
    const roots = [
      join(repoRoot, 'packages/contract/src'),
      join(repoRoot, 'packages/cezar/src'),
      join(repoRoot, 'packages/api-client/src'),
      join(repoRoot, 'packages/web/src'),
      join(repoRoot, 'packages/web/e2e'),
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const relativePath = relative(repoRoot, file);
        if (ALLOWLIST.has(relativePath)) continue;
        const source = readFileSync(file, 'utf8');
        for (const line of handSpelledRunnerObjects(source)) {
          violations.push(`${relativePath}:${line} — per-runner z.object spelled key by key; use perRunner()`);
        }
        const lines = source.split('\n');
        lines.forEach((line, index) => {
          // A deliberate SUBSET of runners (e.g. the model-discovery set) is not a copy of the
          // tuple; it opts out on the line above with a reason, so every exception is reviewable.
          if (index > 0 && lines[index - 1]!.includes(SUBSET_MARKER)) return;
          const distinct = new Set(runnerLiterals(line));
          if (distinct.size < 2) return;
          if (/\[|\||===|!==|\|\|/.test(line)) {
            violations.push(`${relativePath}:${index + 1} — derive from RUNNER_IDS`);
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
