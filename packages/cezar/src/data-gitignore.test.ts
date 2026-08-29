import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard for the rule `AGENTS.md` and `BACKWARD_COMPATIBILITY.md` §3 both state: every new file or
 * directory cezar writes under `.ai/cezar/` must be added to `ensureDataGitignore` IN THE SAME PR.
 *
 * That list is a per-entry allowlist rather than a blanket `*`, deliberately — `workflows/` and
 * `skills/` under the same directory are meant to be committable — so anything not named there is
 * covered by nothing and shows up in the user's `git status`. The attachments library (#attachments-
 * library) shipped exactly that way: every file a user dragged onto the composer landed in a
 * git-visible folder inside their project, one `git add -A` from a public repo.
 *
 * The failure is invisible from inside this repo (cezar's own `.gitignore` ignores `.ai/cezar/`
 * wholesale) and invisible to typecheck, which is why it needs a test rather than care.
 *
 * A STATIC scan on purpose: `ensureDataGitignore` is private to `index.ts`, and exporting it only
 * to assert on it would widen the module's surface for the test's convenience. Reading the two
 * sources keeps the check where the drift happens.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/** The entries `ensureDataGitignore` maintains, read out of its `wanted` array. */
function wantedEntries(): string[] {
  const source = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const start = source.indexOf('function ensureDataGitignore');
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf('const wanted = [', start);
  const close = source.indexOf('];', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  // Line by line, entries only — the list is interleaved with prose comments, and an apostrophe
  // in one of them ("the user's git status") would otherwise be read as a quote and shift every
  // match after it.
  return source
    .slice(open, close)
    .split('\n')
    .map((line) => /^\s*'([^']+)',/.exec(line)?.[1])
    .filter((entry): entry is string => entry !== undefined);
}

/**
 * First path segment of every `join(<…>dataDir, '<literal>'…)` in the service — i.e. every name
 * the code writes directly under `.ai/cezar/`. Literals only: a computed segment cannot be checked
 * statically, and none exists today.
 */
function writtenUnderDataDir(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/join\(\s*(?:this\.)?dataDir\s*,\s*'([^']+)'/g)) {
      found.add(match[1]!);
    }
  }
  return found;
}

describe('ensureDataGitignore covers everything cezar writes under .ai/cezar/', () => {
  it('names the attachments library — user uploads must never reach a user’s git status', () => {
    // The blocker this file exists for, pinned by name so a revert is loud rather than quiet.
    expect(wantedEntries()).toContain('attachments/');
  });

  it('names every directory and file the service writes there', () => {
    const wanted = wantedEntries();
    // The deliberate exceptions: files under this directory built to be COMMITTED, where absence
    // from the ignore list IS the feature. `workflows/` and `skills/` are the project's own
    // playbooks; `config.json` is the optional per-repo config a team may well want in git.
    // Everything else here is run data and belongs to the machine, not the repo.
    const committable = new Set(['workflows', 'skills', 'config.json']);
    const missing = [...writtenUnderDataDir()]
      .filter((name) => !committable.has(name))
      .filter((name) => !wanted.includes(name) && !wanted.includes(`${name}/`));

    expect(
      missing,
      'These names are written under .ai/cezar/ but are absent from ensureDataGitignore, so they ' +
        'surface in every user’s `git status`. Add them to the `wanted` list in index.ts — or, if ' +
        'one is meant to be committed, add it to `committable` here with the reason.',
    ).toEqual([]);
  });
});
