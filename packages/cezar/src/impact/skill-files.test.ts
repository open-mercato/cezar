import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMPACT_PACK_FILES } from '../pack-check.ts';
import { parseFrontmatter } from '../skills.ts';

// The bundled change-impact skill (spec 2026-10-22-html-artifacts-and-impact, Q6) ships as files.
const pkg = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, pkg), 'utf8');

describe('bundled change-impact skill', () => {
  it('names itself change-impact, so it never shadows the owner\'s pr-impact (O4)', () => {
    const { frontmatter: meta } = parseFrontmatter(read('skills/change-impact/SKILL.md'));
    expect(meta.name).toBe('change-impact');
    expect(String(meta.description ?? '').length).toBeGreaterThan(40);
  });

  it('points the agent at cez impact, not at Python, and defines done', () => {
    const skill = read('skills/change-impact/SKILL.md');
    expect(skill).toContain('cez impact evidence');
    expect(skill).toContain('cez impact render');
    expect(skill).toContain('$CEZ_ARTIFACTS_DIR');
    expect(skill).toMatch(/done only when `cez impact render`\s+printed `ok`/);
    expect(skill).not.toMatch(/python3?\s/);
  });

  it('every reference the skill links exists and is packed', () => {
    const skill = read('skills/change-impact/SKILL.md');
    for (const [, link] of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
      expect(IMPACT_PACK_FILES).toContain(`skills/change-impact/${link}`);
      expect(read(`skills/change-impact/${link}`).length).toBeGreaterThan(0);
    }
  });

  it('the analysis contract documents the condition ↔ api_change link', () => {
    expect(read('skills/change-impact/references/analysis-contract.md')).toMatch(/Set `schema_version` to `4`[\s\S]*`api_changes` array of at least one `decision\.conditions` entry/);
  });
});
