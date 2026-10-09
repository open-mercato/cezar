import { describe, expect, test } from 'vitest';
import {
  buildPlannerPrompt,
  buildSkillCatalog,
  PLANNER_CATALOG_DEFAULTS,
} from './planner.ts';
import type { Skill } from './skills.ts';

function skill(name: string, description = `${name} helps with repository changes and verification. `): Skill {
  return { name, description, body: '', path: `/skills/${name}`, source: 'ai' };
}

describe('planner skill catalog', () => {
  test('reduces the synthetic 82-skill catalog to at most one quarter', () => {
    const skills = Array.from({ length: 82 }, (_, index) =>
      skill(`skill-${String(index + 1).padStart(2, '0')}`, 'A '.repeat(180)),
    );
    const original = skills.map((entry) => `- ${entry.name} — ${entry.description}`).join('\n');
    const reduced = buildSkillCatalog('update the repository', skills);

    expect(reduced.length).toBeLessThanOrEqual(original.length / 4);
    expect(reduced).toContain('- skill-82');
    expect(reduced.split('\n')).toHaveLength(82);
  });

  test('puts every explicit mention first and caps descriptions even beyond K', () => {
    const skills = Array.from({ length: 20 }, (_, index) =>
      skill(`skill-${String(index + 1).padStart(2, '0')}`, 'x'.repeat(300)),
    );
    const explicitNames = skills.slice(0, 17).map((entry) => entry.name);
    const catalog = buildSkillCatalog(`please use ${explicitNames.map((name) => `/${name}`).join(' ')}`, skills);
    const lines = catalog.split('\n');

    expect(lines.slice(0, 17).map((line) => line.slice(2).split(' — ')[0])).toEqual(explicitNames);
    expect(lines.slice(0, 17).every((line) => (line.split(' — ')[1] ?? '').length <= 160)).toBe(true);
    expect(lines.slice(17).every((line) => !line.includes(' — '))).toBe(true);
  });

  test('preserves an under-budget catalog and planner prompt byte-for-byte', () => {
    const skills = [skill('alpha', 'first description'), skill('beta', 'second description')];
    const expectedCatalog = '- alpha — first description\n- beta — second description';
    const expectedPrompt = [
      '[cez-planner] Plan a chain of steps for this task.',
      '',
      'Task:',
      'fix alpha',
      '',
      'Skill catalog (name — description):',
      expectedCatalog,
      '',
      'Verification commands detected in this repo:',
      '(none detected)',
    ].join('\n');

    expect(buildSkillCatalog('fix alpha', skills)).toBe(expectedCatalog);
    expect(buildPlannerPrompt('fix alpha', skills, [])).toBe(expectedPrompt);
  });

  test('reduces catalogs above the 6,000-character threshold', () => {
    const exactDescription = 'q'.repeat(6_000 - '- boundary — '.length);
    const exactCatalog = buildSkillCatalog('unrelated task', [skill('boundary', exactDescription)]);
    expect(exactCatalog).toBe(`- boundary — ${exactDescription}`);

    const skills = [skill('large', 'z'.repeat(6_100))];
    expect(buildSkillCatalog('unrelated task', skills)).toBe('- large — ' + 'z'.repeat(160));
    expect(PLANNER_CATALOG_DEFAULTS).toEqual({ maxFull: 15, maxDescriptionChars: 160, budgetChars: 6000 });
  });

  test('ranks by overlap and breaks ties by name deterministically', () => {
    const skills = [
      skill('zulu', 'shared topic ' + 'x'.repeat(6_000)),
      skill('alpha', 'shared topic ' + 'y'.repeat(6_000)),
      skill('relevant', 'other words'),
    ];
    const first = buildSkillCatalog('shared topic', skills);
    const second = buildSkillCatalog('shared topic', skills.slice().reverse());
    expect(first).toBe(second);
    expect(first.indexOf('- alpha —')).toBeLessThan(first.indexOf('- zulu —'));
  });

  test('keeps the empty-catalog marker', () => {
    expect(buildSkillCatalog('anything', [])).toBe('(no skills available)');
  });
});
