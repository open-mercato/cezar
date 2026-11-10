import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '../skills.ts';
import type { ContentBlock } from '../core/agent-runner.ts';
import { expandRegistrySlashSkill, expandRegistrySlashSkillText, isUnknownSkillFailure, skillSystemPrompt } from './run.ts';

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

  /**
   * #811 — a continuation's opening message becomes the session's `userPrompt` and
   * never passes through `deliverMessage`, so the string form is the seam that path
   * needs. Both spellings must agree, or `/skill` would expand on a live follow-up and
   * leak verbatim on the Reply-after-finish that opens the same session.
   */
  describe('expandRegistrySlashSkillText — the continuation seam (#811)', () => {
    it('expands the same way the content-block form does', () => {
      const text = '/om-code-review PR 42';
      const viaText = expandRegistrySlashSkillText(text, [skill]);
      const viaBlocks = expandRegistrySlashSkill([{ type: 'text', text }], [skill]);

      expect(viaText).toContain('Selected skill: /om-code-review');
      expect(viaText).toContain('Skill instructions:\nDo the review.\n\nUser request:\nPR 42');
      expect((viaBlocks[0] as Extract<ContentBlock, { type: 'text' }>).text).toBe(viaText);
    });

    it('expands a bare skill name with no trailing request', () => {
      expect(expandRegistrySlashSkillText('/om-code-review', [skill])).toBe(skillSystemPrompt(skill));
    });

    it.each(['/unknown PR 42', ' /om-code-review PR 42', '/om-code-reviewer PR 42', 'Continue.'])(
      'returns non-matching text unchanged so a backend keeps its own slash commands: %s',
      (text) => {
        expect(expandRegistrySlashSkillText(text, [skill])).toBe(text);
      },
    );

    it('returns the text unchanged against an empty registry (the #811 failure mode)', () => {
      expect(expandRegistrySlashSkillText('/om-code-review PR 42', [])).toBe('/om-code-review PR 42');
    });
  });
});

describe('isUnknownSkillFailure — the skill_missing_in_session signal', () => {
  const tool = (name: string, status: 'failed' | 'completed', error: string) =>
    ({ type: 'item.completed', item: { kind: 'tool', id: 't1', name, toolKind: 'other', title: name, status, error } }) as const;

  it("matches Claude's Skill tool refusing an uninstalled skill", () => {
    expect(isUnknownSkillFailure(tool('Skill', 'failed', '<tool_use_error>Unknown skill: om-auto-review-pr</tool_use_error>'))).toBe(true);
  });

  it('ignores the phrase from any other tool, and a Skill call that succeeded', () => {
    expect(isUnknownSkillFailure(tool('Bash', 'failed', 'expected "Unknown skill: x"'))).toBe(false);
    expect(isUnknownSkillFailure(tool('Skill', 'completed', 'Unknown skill: x'))).toBe(false);
    expect(isUnknownSkillFailure(tool('Skill', 'failed', 'permission denied'))).toBe(false);
  });
});

describe('project commands — $ARGUMENTS and variants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-cmd-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const command = (body: string, extra: Partial<Skill> = {}): Skill => ({
    name: 'speckit.specify', body, path: '/main/.claude/commands/speckit.specify.md', source: 'agents', kind: 'command', ...extra,
  });

  it('substitutes $ARGUMENTS and omits the main-checkout path hint', () => {
    const out = expandRegistrySlashSkillText('/speckit.specify a login page', [command('Spec: $ARGUMENTS ($ARGUMENTS)')]);
    expect(out).toContain('Spec: a login page (a login page)');
    expect(out).not.toContain('Skill files are installed on disk');
    expect(out).toContain('resolve against your working directory');
    expect(out).not.toContain('User request:');
  });

  it('appends the request when the body has no placeholder, and tolerates empty args', () => {
    expect(expandRegistrySlashSkillText('/speckit.specify x', [command('Do it')])).toMatch(/Do it\n\nUser request:\nx$/);
    expect(expandRegistrySlashSkillText('/speckit.specify', [command('Do $ARGUMENTS.')])).toContain('Do .');
  });

  it('passes an unknown slash command through untouched', () => {
    expect(expandRegistrySlashSkillText('/compact now', [command('x')])).toBe('/compact now');
  });

  it('picks the variant written for the selected runner, else the entry body', () => {
    const codex = join(dir, 'review.codex.md');
    const copilot = join(dir, 'review.prompt.md');
    writeFileSync(codex, '---\ndescription: d\n---\ncodex body $ARGUMENTS');
    writeFileSync(copilot, 'copilot body');
    const skill = command('claude body', {
      name: 'review',
      variants: [
        { runner: 'claude', path: '/nowhere' },
        { runner: 'codex', path: codex },
        { runner: 'copilot', path: copilot },
      ],
    });
    expect(expandRegistrySlashSkillText('/review go', [skill], 'codex')).toContain('codex body go');
    expect(expandRegistrySlashSkillText('/review go', [skill], 'copilot')).toContain('copilot body');
    expect(expandRegistrySlashSkillText('/review go', [skill], 'claude')).toContain('claude body');
    expect(expandRegistrySlashSkillText('/review go', [skill], 'cursor')).toContain('claude body');
  });

  it('checks the placeholder in the chosen variant, not the entry body', () => {
    const codex = join(dir, 'ph.codex.md');
    writeFileSync(codex, 'codex $ARGUMENTS');
    const skill = command('claude has none', { name: 'ph', variants: [{ runner: 'codex', path: codex }] });
    expect(expandRegistrySlashSkillText('/ph go', [skill], 'codex')).not.toContain('User request:');
    expect(expandRegistrySlashSkillText('/ph go', [skill], 'claude')).toContain('User request:\ngo');
  });

  it('delivers a step.skill command through the system prompt with {{task}} as the arguments', () => {
    expect(skillSystemPrompt(command('Spec: $ARGUMENTS'), { args: 'a task' })).toContain('Spec: a task');
  });
});
