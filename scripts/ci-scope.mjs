// Decides whether ci.yml's suites must run for a pull request. They run unless every changed path
// is under a directory no suite, build or package step reads, so a new directory runs them.
// Reads changed paths (one per line) on stdin and prints `code=true|false` for $GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Root `*.md` is NOT here: `bc-route-inventory.test.ts` reads BACKWARD_COMPATIBILITY.md.
// codeql.yml's `paths-ignore` repeats this set; `ci-scope.test.ts` keeps the two equal.
export const DOCS_ONLY = [
  '.ai/specs/',
  '.ai/plans/',
  '.ai/analysis/',
  '.ai/runs/',
  'docs/adr/',
  'docs/mockups/',
  'docs/screenshots/',
];

/** `true` when any changed path can reach a suite; no paths at all is `true`. */
export function suitesNeeded(paths) {
  const changed = paths.map((path) => path.trim()).filter(Boolean);
  if (changed.length === 0) return true;
  return changed.some((path) => !DOCS_ONLY.some((prefix) => path.startsWith(prefix)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`code=${suitesNeeded(readFileSync(0, 'utf8').split('\n'))}`);
}
