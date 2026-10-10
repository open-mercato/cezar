import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import {
  expandRegistrySlashSkill,
  expandRegistrySlashSkillText,
  skillDelivery,
  skillSystemPrompt,
} from './run.ts';
import { DEFAULT_ALLOWED_TOOLS } from './types.ts';

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

describe('skillDelivery — which skills travel as a path', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A temp cwd holding `<mirror>/<name>/SKILL.md`, or no copy when mirror is undefined. */
  const cwdWith = (mirror?: string, name = 'om-code-review', declared = name): string => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-skill-delivery-'));
    dirs.push(cwd);
    if (mirror) {
      const dir = join(cwd, mirror, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${declared}\n---\nbody\n`);
    }
    return cwd;
  };
  const main = mkdtempSync(join(tmpdir(), 'cez-skill-source-'));
  mkdirSync(join(main, '.ai/skills/om-code-review'), { recursive: true });
  writeFileSync(join(main, '.ai/skills/om-code-review/SKILL.md'), '---\nname: om-code-review\n---\nbody\n');
  afterAll(() => rmSync(main, { recursive: true, force: true }));
  const dirSkill = { name: 'om-code-review', path: join(main, '.ai/skills/om-code-review/SKILL.md'), source: 'ai' as const };

  it('names a copy inside the worktree, in whichever native mirror has it', () => {
    const agents = cwdWith('.agents/skills');
    expect(skillDelivery(dirSkill, 'claude', agents)).toEqual({
      mode: 'path',
      file: join(agents, '.agents/skills/om-code-review/SKILL.md'),
    });
    const claude = cwdWith('.claude/skills');
    expect(skillDelivery(dirSkill, 'claude', claude)).toEqual({
      mode: 'path',
      file: join(claude, '.claude/skills/om-code-review/SKILL.md'),
    });
  });

  it.each(['claude', 'claude-cli', 'codex', 'opencode'] as const)('uses the worktree copy on %s', (backend) => {
    expect(skillDelivery(dirSkill, backend, cwdWith('.agents/skills')).mode).toBe('path');
  });

  it('inlines on a backend whose native skill loading is not verified', () => {
    expect(skillDelivery(dirSkill, 'pi', cwdWith('.agents/skills'))).toEqual({ mode: 'inline' });
  });

  it('never names a worktree skill in that directory that declares another name', () => {
    const cwd = cwdWith('.agents/skills', 'om-code-review', 'another-skill');
    expect(skillDelivery(dirSkill, 'claude', cwd)).toEqual({ mode: 'inline' });
  });

  it('never names a same-named worktree copy whose files differ from the selected skill', () => {
    // A tracked `.agents/skills/<name>` that discovery shadowed with a higher-precedence source.
    const shadowed = cwdWith('.agents/skills');
    writeFileSync(join(shadowed, '.agents/skills/om-code-review/SKILL.md'), '---\nname: om-code-review\n---\nshadowed\n');
    expect(skillDelivery(dirSkill, 'claude', shadowed)).toEqual({ mode: 'inline' });
    // A copy an earlier step added a file to.
    const extended = cwdWith('.claude/skills');
    writeFileSync(join(extended, '.claude/skills/om-code-review/extra.md'), 'do something else\n');
    expect(skillDelivery(dirSkill, 'claude', extended)).toEqual({ mode: 'inline' });
    // A copy whose source is gone cannot be verified.
    const orphan = { ...dirSkill, path: join(main, '.ai/skills/missing/SKILL.md') };
    expect(skillDelivery(orphan, 'claude', cwdWith('.agents/skills'))).toEqual({ mode: 'inline' });
  });

  it('inlines an empty or unreadable worktree copy instead of naming it', () => {
    const cwd = cwdWith('.agents/skills');
    writeFileSync(join(cwd, '.agents/skills/om-code-review/SKILL.md'), '');
    expect(skillDelivery(dirSkill, 'claude', cwd)).toEqual({ mode: 'inline' });
  });

  it('inlines when the worktree has no copy — a source dir outside it would need a write grant', () => {
    expect(skillDelivery(dirSkill, 'claude', cwdWith())).toEqual({ mode: 'inline' });
    const global = { name: 'g', path: '/home/u/.claude/skills/g/SKILL.md', source: 'global' as const };
    expect(skillDelivery(global, 'claude', cwdWith())).toEqual({ mode: 'inline' });
  });

  it('names an in-place installed copy that sits inside the working directory', () => {
    const cwd = cwdWith();
    const file = join(cwd, '.ai/skills/demo/SKILL.md');
    mkdirSync(join(cwd, '.ai/skills/demo'), { recursive: true });
    writeFileSync(file, '---\nname: demo\n---\nbody\n');
    const skill = { name: 'demo', path: file, source: 'ai' as const };
    expect(skillDelivery(skill, 'claude', cwd)).toEqual({ mode: 'path', file });
    expect(skillDelivery(skill, 'claude', cwd, ['Skill'])).toEqual({ mode: 'inline' });
    expect(skillDelivery(skill, 'claude', cwd, ['Read'])).toEqual({ mode: 'path', file });
  });

  it('inlines when a Claude step allowlist does not grant Read', () => {
    // `--allowedTools` is default-deny on Claude, so a path it cannot read is worse than the body.
    expect(skillDelivery(dirSkill, 'claude', cwdWith('.agents/skills'), ['Bash'])).toEqual({ mode: 'inline' });
    expect(skillDelivery(dirSkill, 'claude', cwdWith('.agents/skills'), ['Skill'])).toEqual({ mode: 'inline' });
    expect(skillDelivery(dirSkill, 'claude', cwdWith('.agents/skills'), ['Read']).mode).toBe('path');
    // The zero-config default reaches a path through `Read` alone, without widening the step to `Skill`.
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Skill');
    expect(skillDelivery(dirSkill, 'claude', cwdWith('.agents/skills'), DEFAULT_ALLOWED_TOOLS).mode).toBe('path');
    // Codex/OpenCode ignore the allowlist and keep their own file access.
    expect(skillDelivery(dirSkill, 'codex', cwdWith('.agents/skills'), ['Bash']).mode).toBe('path');
  });

  it('inlines a single-file skill and the built-in skill', () => {
    const cwd = cwdWith();
    expect(skillDelivery({ name: 'flat', path: '/main/.ai/skills/flat.md', source: 'ai' }, 'claude', cwd)).toEqual({ mode: 'inline' });
    expect(skillDelivery({ name: 'b', path: 'builtin:b', source: 'builtin' }, 'claude', cwd)).toEqual({ mode: 'inline' });
  });

  it('uses a materialized team skill, and inlines one that was not materialized', () => {
    const team = { name: 'team-skill', path: 'o/r@main:team-skill/SKILL.md', source: 'team' as const };
    const cwd = cwdWith('.claude/skills', 'team-skill');
    expect(skillDelivery(team, 'claude', cwd)).toEqual({
      mode: 'path',
      file: join(cwd, '.claude/skills/team-skill/SKILL.md'),
    });
    expect(skillDelivery(team, 'claude', cwdWith())).toEqual({ mode: 'inline' });
  });
});

describe('skillSystemPrompt — path delivery', () => {
  const skill = { name: 'om-code-review', description: 'Review a diff.', body: 'Do the review.', source: 'agents' as const, path: '/p/SKILL.md' };

  it('carries identity, the file and the load instruction, but not the body', () => {
    const out = skillSystemPrompt(skill, { mode: 'path', file: '/wt/.agents/skills/om-code-review/SKILL.md' });
    expect(out).toContain('Selected skill: /om-code-review');
    expect(out).toContain('Description: Review a diff.');
    expect(out).toContain('Skill file: /wt/.agents/skills/om-code-review/SKILL.md');
    expect(out).toContain('skill tool');
    expect(out).not.toContain('Do the review.');
  });

  it('keeps the inlined body by default', () => {
    expect(skillSystemPrompt(skill)).toContain('Skill instructions:\nDo the review.');
  });
});

describe('expandRegistrySlashSkillText — step skill dedupe and backend-aware delivery', () => {
  const skill = {
    name: 'om-code-review',
    description: 'Review a diff.',
    body: 'Do the review.',
    path: '/main/.agents/skills/om-code-review/SKILL.md',
    source: 'agents' as const,
  };

  it('keeps only the request when the step already selects the same skill', () => {
    expect(expandRegistrySlashSkillText('/om-code-review PR 42', [skill], { stepSkill: 'om-code-review' })).toBe('PR 42');
  });

  it('turns a request-less duplicate into an instruction instead of an empty prompt', () => {
    expect(expandRegistrySlashSkillText('/om-code-review', [skill], { stepSkill: 'om-code-review' })).toBe(
      'Follow the selected skill /om-code-review.',
    );
  });

  it('still expands a different skill than the step selects', () => {
    expect(expandRegistrySlashSkillText('/om-code-review PR 42', [skill], { stepSkill: 'other' })).toContain(
      'Skill instructions:\nDo the review.',
    );
  });

  it('names the worktree copy instead of the body when the backend loads skills natively', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-skill-expand-'));
    try {
      mkdirSync(join(cwd, '.agents/skills/om-code-review'), { recursive: true });
      writeFileSync(join(cwd, '.agents/skills/om-code-review/SKILL.md'), '---\nname: om-code-review\n---\nbody\n');
      const installed = { ...skill, path: join(cwd, '.agents/skills/om-code-review/SKILL.md') };
      const out = expandRegistrySlashSkillText('/om-code-review PR 42', [installed], { backend: 'claude', cwd });
      expect(out).toContain(`Skill file: ${join(cwd, '.agents/skills/om-code-review/SKILL.md')}`);
      expect(out).not.toContain('Do the review.');
      expect(out.endsWith('User request:\nPR 42')).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('inlines the body when a restricted allowlist could not read the named path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-skill-expand-'));
    try {
      mkdirSync(join(cwd, '.agents/skills/om-code-review'), { recursive: true });
      writeFileSync(join(cwd, '.agents/skills/om-code-review/SKILL.md'), '---\nname: om-code-review\n---\nbody\n');
      const out = expandRegistrySlashSkillText('/om-code-review PR 42', [skill], {
        backend: 'claude',
        cwd,
        allowedTools: ['Bash'],
      });
      expect(out).toContain('Skill instructions:\nDo the review.');
      expect(out).not.toContain('Skill file:');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
