import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeAdvisorRefs } from './advisor-identity.js';
import { acquireIssueClaim, releaseIssueClaim } from './issue-claim.js';
import {
  HARNESS_PROMPT_BUDGET_BYTES,
  promptBudgetError,
  promptExcerpt,
} from './prompt-budget.js';
import { harnessStageResultSchema, samePathSet } from './stage-result.js';
import { harnessPhaseSkills } from './skill-routing.js';
import { createClaudeStageOnlySettings } from './claude-guard.js';

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

describe('harness safety primitives', () => {
  it('rejects advisor family tampering and returns the trusted family', () => {
    const models = { deepseek: { family: 'deepseek' } };
    expect(
      canonicalizeAdvisorRefs(
        [{ runner: 'harness', model: 'deepseek', family: 'openai' }],
        models,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('trusted configuration') });
    expect(
      canonicalizeAdvisorRefs(
        [{ runner: 'harness', model: 'deepseek' }],
        models,
      ),
    ).toEqual({
      ok: true,
      refs: [{ runner: 'harness', model: 'deepseek', family: 'deepseek' }],
    });
  });

  it('budgets the complete prompt and marks model-facing excerpts', () => {
    expect(promptBudgetError('small')).toBeNull();
    expect(promptBudgetError('x'.repeat(HARNESS_PROMPT_BUDGET_BYTES + 1))).toMatch(
      /exceeding/,
    );
    expect(promptExcerpt('abcdefgh', 4)).toContain('abcd\n…');
  });

  it('parses only bounded, explicit stage results and compares path sets', () => {
    expect(
      harnessStageResultSchema.safeParse({
        status: 'ready',
        stagedPaths: ['src/a.ts'],
      }).success,
    ).toBe(true);
    expect(
      harnessStageResultSchema.safeParse({
        status: 'ready',
        stagedPaths: Array.from({ length: 201 }, (_, index) => `src/${index}.ts`),
      }).success,
    ).toBe(false);
    expect(samePathSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(samePathSet(['a'], ['a', 'b'])).toBe(false);
  });

  it('holds one local issue lease, permits same-run recovery, and releases by owner', () => {
    const cwd = tempDir('cez-claim-');
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
    const first = acquireIssueClaim(cwd, 'run-a', '642');
    expect(first.ok).toBe(true);
    expect(acquireIssueClaim(cwd, 'run-a', '642')).toMatchObject({ ok: true });
    expect(acquireIssueClaim(cwd, 'run-b', '642')).toMatchObject({
      ok: false,
      error: expect.stringContaining('run-a'),
    });
    if (!first.ok) throw new Error(first.error);
    expect(releaseIssueClaim(first.claim.path, 'run-b')).toMatchObject({ ok: false });
    expect(releaseIssueClaim(first.claim.path, 'run-a')).toEqual({ ok: true });
    expect(acquireIssueClaim(cwd, 'run-b', '642')).toMatchObject({ ok: true });
  });

  it('materializes a strict Claude sandbox and rejects writes outside the worktree', () => {
    const root = tempDir('cez-claude-guard-');
    const worktree = join(root, 'worktree');
    const artifacts = join(root, 'artifacts');
    mkdirSync(worktree);
    const guard = createClaudeStageOnlySettings(artifacts, worktree);
    const settings = JSON.parse(readFileSync(guard.settingsPath, 'utf8')) as {
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
      };
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    const guardPath = JSON.parse(command.slice('node '.length)) as string;
    const invoke = (toolInput: Record<string, string>) =>
      execFileSync(process.execPath, [guardPath], {
        input: JSON.stringify({ tool_input: toolInput }),
        env: { ...process.env, ...guard.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    expect(() => invoke({ file_path: join(worktree, 'src', 'safe.ts') })).not.toThrow();
    expect(() => invoke({ file_path: join(root, 'outside.ts') })).toThrow();
    expect(() => invoke({ command: 'git push origin HEAD' })).toThrow();
    expect(() => invoke({ command: 'git -C . push origin HEAD' })).toThrow();
    expect(() => invoke({ command: '/usr/bin/git --no-pager commit -m unsafe' })).toThrow();
    expect(() => invoke({ command: 'gh --repo owner/repo pr create --fill' })).toThrow();
    expect(() => invoke({ command: 'gh issue edit 42 --add-assignee @me' })).toThrow();
    expect(() => invoke({ command: 'gh pr review 42 --approve' })).toThrow();
    expect(() => invoke({ command: 'gh issue view 42 --json title' })).not.toThrow();
    expect(() => invoke({ command: 'printf "git"; echo push' })).not.toThrow();
  });

  it('routes generic repositories to complete bundled Cezar skills by default', () => {
    expect(harnessPhaseSkills()).toEqual({
      specWriting: 'cez-spec-writing',
      preImplement: 'cez-pre-implement-spec',
      implementSpec: 'cez-implement-spec',
      codeReview: 'cez-code-review',
      qualify: 'cez-verify-in-repo',
      diagnose: 'cez-root-cause',
      fix: 'cez-fix',
    });
  });

  it('routes Open Mercato repositories to the exact canonical om-* skills', () => {
    expect(harnessPhaseSkills('open-mercato')).toEqual({
      specWriting: 'om-spec-writing',
      preImplement: 'om-pre-implement-spec',
      implementSpec: 'om-implement-spec',
      codeReview: 'om-code-review',
      qualify: 'om-verify-in-repo',
      diagnose: 'om-root-cause',
      fix: 'om-fix',
    });
  });
});
