import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// ci.yml's `scope` job (scripts/ci-scope.mjs): a wrong "docs-only" answer merges code with the
// required checks green and nothing run, so the decision and its wiring are pinned here.

const root = new URL('../../../../', import.meta.url);
const script = fileURLToPath(new URL('scripts/ci-scope.mjs', root));
const { DOCS_ONLY, suitesNeeded } = (await import(new URL('scripts/ci-scope.mjs', root).href)) as {
  DOCS_ONLY: string[];
  suitesNeeded: (paths: string[]) => boolean;
};
const load = (rel: string) => parse(readFileSync(new URL(rel, root), 'utf8')) as Record<string, any>;

describe('ci scope', () => {
  it('skips the suites when every path is docs-only', () => {
    expect(suitesNeeded(['.ai/specs/2026-11-23-x.md'])).toBe(false);
    expect(suitesNeeded(['.ai/specs/x.md', '.ai/specs/assets/x/shot.png', 'docs/mockups/a.html', '.ai/runs/r/notes.md'])).toBe(false);
  });

  it('runs them for any other path, including root and docs Markdown', () => {
    for (const path of [
      'BACKWARD_COMPATIBILITY.md',
      'README.md',
      'docs/reference.md',
      'docs/site/content/docs/index.mdx',
      '.ai/specsx/a.md',
      '.ai/skills/x/SKILL.md',
      '"docs/adr/\\303\\251.md"',
      'packages/cezar/src/index.ts',
    ]) expect(suitesNeeded(['.ai/specs/x.md', path]), path).toBe(true);
  });

  it('fails toward running them on an empty list', () => {
    expect(suitesNeeded([])).toBe(true);
    expect(suitesNeeded(['', '  '])).toBe(true);
  });

  it('prints a GITHUB_OUTPUT line', () => {
    const run = (input: string) => execFileSync('node', [script], { input, encoding: 'utf8' }).trim();
    expect(run('.ai/specs/x.md\n')).toBe('code=false');
    expect(run('.ai/specs/x.md\npackages/x.ts\n')).toBe('code=true');
    expect(run('')).toBe('code=true');
  });

  it('keeps codeql.yml paths-ignore equal to the docs-only set', () => {
    const ignored = load('.github/workflows/codeql.yml').on.pull_request['paths-ignore'];
    expect(ignored).toEqual(DOCS_ONLY.map((prefix) => `${prefix}**`));
  });

  it('skips the required shards per step and verify as a whole job', () => {
    const { jobs } = load('.github/workflows/ci.yml');
    expect(jobs.scope.if).toContain('github.event.pull_request.draft == false');
    expect(jobs.scope.steps.some((s: any) => String(s.run).includes('node scripts/ci-scope.mjs'))).toBe(true);
    // A matrix job skipped whole reports under its unexpanded name, which no required check matches.
    expect(jobs.vitest.needs).toBe('scope');
    expect(jobs.vitest.if).toBeUndefined();
    for (const step of jobs.vitest.steps) expect(step.if, step.name).toBe("needs.scope.outputs.code == 'true'");
    expect(jobs.verify.if).toBe("needs.scope.outputs.code == 'true'");
    expect(load('.github/workflows/ci.yml').on.pull_request.types).toContain('ready_for_review');
  });
});
