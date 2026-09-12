import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `ensureDataGitignore` (`index.ts`) keeps cezar's run data out of the user's git history by
 * naming every entry it writes under `.ai/cezar/`, one by one.
 *
 * That per-entry allowlist is deliberate rather than a blanket `*` — `workflows/` and `skills/`
 * under the same directory are the project's own playbooks and are meant to be committed — which
 * has a sharp consequence: anything NOT named there is covered by nothing, and shows up in the
 * user's `git status`. The attachment library (#929) is what makes that consequence expensive:
 * the entries are files the user uploaded, so a missing line is one `git add -A` from putting an
 * internal PDF in a public repository.
 *
 * The failure is invisible from inside this repository — cezar's own root `.gitignore` ignores
 * `.ai/cezar/` wholesale — and invisible to typecheck. So it needs a test rather than care.
 *
 * A STATIC scan on purpose: `ensureDataGitignore` is private to `index.ts`, and exporting it only
 * so a test could call it would widen the module's surface for the test's convenience. Reading the
 * two sources keeps the check where the drift actually happens.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every non-test `.ts` file in the service. */
function serviceSources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return serviceSources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * The entries `ensureDataGitignore` writes, read out of its `wanted` array.
 *
 * Comment lines are dropped before the quotes are matched. The array is heavily commented, and
 * one apostrophe in that prose ("the user's `git status`") would pair a quote across it and inject
 * a phantom entry — which fails in the one direction this test must never fail in, by making the
 * cross-check below MORE permissive rather than less.
 */
function wantedEntries(): string[] {
  const source = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const block = /function ensureDataGitignore[\s\S]*?const wanted = \[([\s\S]*?)\n {2}\];/.exec(source);
  expect(block, 'ensureDataGitignore’s `wanted` array should be findable in index.ts').toBeTruthy();
  const code = (block?.[1] ?? '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * The first path segment of every `join(<…>dataDir, '<literal>', …)` in the service.
 *
 * Scope, stated honestly: this catches the literal-first-segment shape, which is how essentially
 * every data path in this codebase is written and how a new one will be written too. A module that
 * hides its filename behind a constant (`automations/store.ts` does) is not caught — those entries
 * are already listed, and widening the scan to chase constants across modules would trade a guard
 * that is obviously right for one that is merely clever.
 */
function writtenUnderDataDir(): Set<string> {
  const found = new Set<string>();
  for (const file of serviceSources()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/join\(\s*(?:this\.)?dataDir\s*,\s*'([^']+)'/g)) {
      found.add(match[1] as string);
    }
  }
  return found;
}

describe('ensureDataGitignore covers everything cezar writes under .ai/cezar/', () => {
  it('names the attachment library — user uploads must never reach a user’s git status', () => {
    // The blocker this file exists for, pinned by name so a revert is loud rather than quiet.
    expect(wantedEntries()).toContain('attachments/');
  });

  it('names every directory and file the service writes there', () => {
    const wanted = wantedEntries();
    // The deliberate exceptions: entries under this directory built to be COMMITTED, where absence
    // from the ignore list IS the feature. `workflows/` and `skills/` are the project's own
    // playbooks; `config.json` is the optional per-repo config a team may well want in git; the
    // `.gitignore` is the file itself, which git has to be able to see.
    const committable = new Set(['workflows', 'skills', 'config.json', '.gitignore']);
    const missing = [...writtenUnderDataDir()]
      .filter((name) => !committable.has(name))
      .filter((name) => !wanted.includes(name) && !wanted.includes(`${name}/`));
    expect(
      missing,
      `these are written under .ai/cezar/ but are not in ensureDataGitignore's list, so they will ` +
        `appear in the user's git status: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * Adding an entry only helps a fresh `init` unless the writer also repairs a file that already
   * exists — and every affected user already has one. `index.ts` has no exports (importing it runs
   * the CLI), so this is pinned statically: the write must be `current` plus the entries missing
   * from it, never a rewrite of the whole file, which would also discard anything a user added.
   */
  it('appends missing entries to an existing file rather than rewriting it, so old installs self-heal', () => {
    const source = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const body = /function ensureDataGitignore[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    expect(body).toMatch(/const current = existsSync\(path\) \? readFileSync\(path, 'utf8'\) : ''/);
    expect(body).toMatch(/const missing = wanted\.filter\(/);
    expect(body).toMatch(/writeFileSync\(path, `\$\{current\}/);
  });

  it('scans something — a regex that silently stopped matching would pass every other case here', () => {
    // Both halves of the check are regex-driven, and a regex that matches nothing makes an empty
    // `missing` list for the wrong reason. Pin a floor on each.
    expect(wantedEntries().length).toBeGreaterThan(10);
    expect(writtenUnderDataDir().size).toBeGreaterThan(3);
    expect(serviceSources().length).toBeGreaterThan(20);
    expect(relative(SRC, serviceSources()[0] as string)).not.toBe('');
  });
});
