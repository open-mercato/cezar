import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_GITIGNORE_ENTRIES, ensureDataGitignore } from './data-gitignore.ts';

describe('ensureDataGitignore', () => {
  let repoRoot: string;
  const gitignore = () => readFileSync(join(repoRoot, '.ai/cezar', '.gitignore'), 'utf8');

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gitignore-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('writes every run-data entry into a fresh repo', () => {
    ensureDataGitignore(repoRoot);
    const lines = gitignore().split('\n');
    for (const entry of DATA_GITIGNORE_ENTRIES) expect(lines, entry).toContain(entry);
  });

  it('ignores unsent drafts — a pasted screenshot must never reach the user\'s git history', () => {
    ensureDataGitignore(repoRoot);
    expect(gitignore().split('\n')).toContain('drafts/');
  });

  it('ignores the attachment library — user uploads must never reach a user’s git status', () => {
    // The blocker this case exists for, pinned by name so a revert is loud rather than quiet:
    // the entries under `attachments/` are files the user uploaded, so a missing line is one
    // `git add -A` from putting an internal PDF in a public repository (#929).
    ensureDataGitignore(repoRoot);
    expect(gitignore().split('\n')).toContain('attachments/');
  });

  it('appends what is missing and keeps what the user added', () => {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', '.gitignore'), 'runs.json\nmy-own-scratch/\n', 'utf8');

    ensureDataGitignore(repoRoot);

    const lines = gitignore().split('\n');
    expect(lines).toContain('my-own-scratch/');
    expect(lines).toContain('drafts/');
    expect(lines.filter((l) => l === 'runs.json')).toHaveLength(1); // never duplicated
  });

  it('is idempotent', () => {
    ensureDataGitignore(repoRoot);
    const once = gitignore();
    ensureDataGitignore(repoRoot);
    expect(gitignore()).toBe(once);
  });
});

/**
 * The entry list is a per-entry allowlist rather than a blanket `*` — `workflows/` and `skills/`
 * under the same directory are the project's own playbooks and are meant to be committed — which
 * has a sharp consequence: anything NOT named there is covered by nothing, and shows up in the
 * user's `git status`.
 *
 * The failure is invisible from inside this repository — cezar's own root `.gitignore` ignores
 * `.ai/cezar/` wholesale — and invisible to typecheck. So it needs a test rather than care.
 */
describe('DATA_GITIGNORE_ENTRIES covers everything cezar writes under .ai/cezar/', () => {
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

  it('names every directory and file the service writes there', () => {
    const wanted: readonly string[] = DATA_GITIGNORE_ENTRIES;
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
      `these are written under .ai/cezar/ but are not in DATA_GITIGNORE_ENTRIES, so they will ` +
        `appear in the user's git status: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('scans something — a regex that silently stopped matching would pass every other case here', () => {
    // The scan half of the check is regex-driven, and a regex that matches nothing makes an empty
    // `missing` list for the wrong reason. Pin a floor on it.
    expect(DATA_GITIGNORE_ENTRIES.length).toBeGreaterThan(10);
    expect(writtenUnderDataDir().size).toBeGreaterThan(3);
    expect(serviceSources().length).toBeGreaterThan(20);
    expect(relative(SRC, serviceSources()[0] as string)).not.toBe('');
  });
});
