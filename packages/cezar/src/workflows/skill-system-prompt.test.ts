import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import { expandRegistrySlashSkill, skillSystemPrompt } from './run.ts';

describe('skillSystemPrompt — installed-path hint for worktree agents', () => {
  const base = { name: 'om-code-review', description: 'Review a diff.', body: 'Do the review.' };

  it('points an on-disk skill at its absolute installed directory', () => {
    const out = skillSystemPrompt({
      ...base,
      source: 'agents',
      path: '/home/u/Projects/app/.agents/skills/om-code-review/SKILL.md',
    });
    expect(out).toContain('Skill files are installed on disk at: /home/u/Projects/app/.agents/skills/om-code-review');
    expect(out).toContain('references/*.md');
    // Body still present and last.
    expect(out.trimEnd().endsWith('Do the review.')).toBe(true);
  });

  it('omits the path hint for team skills (they are materialized separately)', () => {
    const out = skillSystemPrompt({ ...base, source: 'team', path: '/cache/whatever/SKILL.md' });
    expect(out).not.toContain('installed on disk at');
  });

  it('omits the path hint when no path/source is known', () => {
    const out = skillSystemPrompt(base);
    expect(out).not.toContain('installed on disk at');
  });
});

describe('expandRegistrySlashSkill — live chat delivery', () => {
  const skill = {
    name: 'om-code-review',
    description: 'Review a diff.',
    body: 'Do the review.',
    path: '/home/u/.agents/skills/om-code-review/SKILL.md',
    source: 'global' as const,
  };

  it('replaces a matching leading slash skill with the canonical selected-skill prompt', () => {
    const content: ContentBlock[] = [{ type: 'text', text: '/om-code-review PR 42' }];

    const expanded = expandRegistrySlashSkill(content, [skill]);

    expect(expanded).not.toBe(content);
    expect(expanded[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Selected skill: /om-code-review'),
    });
    expect((expanded[0] as Extract<ContentBlock, { type: 'text' }>).text).toContain(
      'Skill instructions:\nDo the review.\n\nUser request:\nPR 42',
    );
    expect(content[0]).toEqual({ type: 'text', text: '/om-code-review PR 42' });
  });

  it.each(['/unknown PR 42', ' /om-code-review PR 42', '/om-code-reviewer PR 42'])(
    'leaves non-matching text unchanged: %s',
    (text) => {
      const content: ContentBlock[] = [{ type: 'text', text }];
      expect(expandRegistrySlashSkill(content, [skill])).toBe(content);
    },
  );

  it('preserves image blocks while expanding the first text block', () => {
    const image: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
    };
    const expanded = expandRegistrySlashSkill([image, { type: 'text', text: '/om-code-review' }], [skill]);

    expect(expanded[0]).toBe(image);
    expect((expanded[1] as Extract<ContentBlock, { type: 'text' }>).text).toContain('Do the review.');
  });
});
