import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  discoverSkills,
  skillsForStage,
  SKILL_SOURCE_PRIORITY,
  type SkillSource,
} from '../../src/skills/skill-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRepoRoot = join(here, '..', 'fixtures', 'skills-repo');

// `discoverSkills` now returns the merged catalog — built-in skills shipped
// with @cezar/core plus repo `.ai/skills/`. These tests intentionally assert
// repo-side discovery only by filtering by source.
function repoSkills(s: Awaited<ReturnType<typeof discoverSkills>>) {
  return s.filter((x) => x.source === 'workspace-repo');
}

describe('discoverSkills', () => {
  it('finds skills, parses frontmatter, strips it from body, sorts by name', async () => {
    const skills = repoSkills(await discoverSkills(fixtureRepoRoot));
    expect(skills.map((s) => s.name)).toEqual(['deep-root-cause', 'house-style']);

    const deep = skills.find((s) => s.name === 'deep-root-cause')!;
    expect(deep.description).toBe("Extra root-cause guidance for this repo's domain.");
    expect(deep.suggestedStages).toEqual(['root-cause', 'verify-in-repo']);
    expect(deep.body).not.toContain('---');
    expect(deep.body).not.toContain('cezar-stages');
    expect(deep.body).toContain('# Repo root-cause notes');
    expect(deep.body).toContain('request-id middleware');
    expect(deep.path).toContain('root-cause.md');

    const house = skills.find((s) => s.name === 'house-style')!;
    expect(house.description).toBeUndefined();
    expect(house.suggestedStages).toEqual([]);
    expect(house.body).toContain('# House style');
    expect(house.body).toContain('Prefer named exports.');
  });

  it('returns no repo skills when the skills directory does not exist', async () => {
    const skills = repoSkills(await discoverSkills(fixtureRepoRoot, '.does-not-exist/skills'));
    expect(skills).toEqual([]);
  });

  it('returns no repo skills for a repo with no .ai/skills at all', async () => {
    const skills = repoSkills(await discoverSkills(join(here, '..', 'fixtures', 'no-such-repo')));
    expect(skills).toEqual([]);
  });

  it('returns built-in skills regardless of the repo state', async () => {
    const skills = await discoverSkills(join(here, '..', 'fixtures', 'no-such-repo'));
    // At least one built-in (bug-classification) ships with @cezar/core.
    expect(skills.some((s) => s.source === 'built-in' && s.name === 'bug-classification')).toBe(
      true,
    );
  });
});

describe('SkillSource', () => {
  it('reports the renamed `workspace-repo` provenance for repo-side skills', async () => {
    const skills = await discoverSkills(fixtureRepoRoot);
    const repo = skills.filter((s) => s.name === 'deep-root-cause' || s.name === 'house-style');
    expect(repo.length).toBeGreaterThan(0);
    for (const s of repo) {
      // Legacy literal `'repo'` is gone; readers must accept the new value.
      expect(s.source).toBe('workspace-repo');
    }
  });

  it('lists every source kind in priority order', () => {
    // The order matters — later PRs use it to resolve cross-source collisions.
    const expected: SkillSource[] = [
      'built-in',
      'workspace-repo',
      'external-repo',
      'disk',
      'skills-sh',
    ];
    expect(SKILL_SOURCE_PRIORITY).toEqual(expected);
    // No duplicates.
    expect(new Set(SKILL_SOURCE_PRIORITY).size).toBe(SKILL_SOURCE_PRIORITY.length);
  });
});

describe('skillsForStage', () => {
  it('partitions skills by whether suggestedStages includes the stage', async () => {
    const skills = repoSkills(await discoverSkills(fixtureRepoRoot));
    const { suggested, others } = skillsForStage(skills, 'root-cause');
    expect(suggested.map((s) => s.name)).toEqual(['deep-root-cause']);
    expect(others.map((s) => s.name)).toEqual(['house-style']);

    const forFix = skillsForStage(skills, 'fix');
    expect(forFix.suggested).toEqual([]);
    expect(forFix.others.map((s) => s.name)).toEqual(['deep-root-cause', 'house-style']);
  });
});
