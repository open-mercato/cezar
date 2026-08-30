import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
