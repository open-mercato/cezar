import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HARNESS_SKILL = join(
  import.meta.dirname,
  '..',
  '..',
  'vendor',
  'skills',
  'cez-harness',
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, encoding: 'utf8', env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('advisor reviewer prompt', () => {
  it('sends the complete materialized om-code-review rubric and records the prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-prompt-'));
    roots.push(root);
    const skillsRoot = join(root, 'skills');
    const harnessSkill = join(skillsRoot, 'cez-harness');
    const reviewSkill = join(skillsRoot, 'om-code-review');
    cpSync(HARNESS_SKILL, harnessSkill, { recursive: true });
    mkdirSync(join(reviewSkill, 'references'), { recursive: true });
    writeFileSync(
      join(reviewSkill, 'SKILL.md'),
      '# Code Review\nCanonical om-code-review skill body.\n',
    );
    writeFileSync(
      join(reviewSkill, 'references', 'review-checklist.md'),
      '# Code Review Checklist — Full Reference\nCheck state-machine, retry, recovery, cancellation.\n',
    );
    writeFileSync(
      join(reviewSkill, 'references', 'output-format.md'),
      '# Review report output format\nReturn a mechanical approve or request-changes verdict.\n',
    );
    const runtime = join(harnessSkill, 'scripts', 'harness.mjs');
    const worktree = join(root, 'worktree');
    mkdirSync(worktree, { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], worktree);
    writeFileSync(join(worktree, 'app.ts'), 'export const value = 1;\n');
    await run('git', ['add', '-A'], worktree);
    await run(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-q', '-m', 'base'],
      worktree,
    );
    writeFileSync(join(worktree, 'app.ts'), 'export const value = 2;\n');

    const stub = join(root, 'stub-reviewer.mjs');
    writeFileSync(stub, 'process.stdout.write(JSON.stringify({verdict:"approve",findings:[],notes:[]}))\n');

    const configPath = join(root, 'agentic.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        agentHarness: {
          version: 1,
          delivery: { mode: 'stage-only', issueClaim: 'hold' },
          models: {
            stub: {
              adapter: 'command',
              family: 'stub-family',
              model: 'stub-model',
              roles: ['reviewer'],
              timeoutMs: 60_000,
              commands: {
                probe: [process.execPath, '--version'],
                review: [process.execPath, stub, '{promptFile}'],
              },
            },
          },
          profiles: {
            council: { workers: [], reviewers: ['stub'], reviewPolicy: { mode: 'advisory' } },
          },
        },
      }),
    );

    const criteriaPath = join(root, 'criteria.md');
    writeFileSync(
      criteriaPath,
      'Role-based cezar council criteria (run test).\n\nThe task under review: improve the inbox\n',
    );

    const promptDir = join(root, 'artifacts');
    const result = await run(
      process.execPath,
      [
        runtime,
        'review',
        '--config',
        configPath,
        '--profile',
        'council',
        '--worktree',
        worktree,
        '--criteria-file',
        criteriaPath,
        '--output-dir',
        join(root, 'out'),
        '--prompt-dir',
        promptDir,
      ],
      root,
      { CEZ_HARNESS_REVIEW_SKILL: 'om-code-review' },
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const written = readdirSync(promptDir).filter((name) => name.startsWith('reviewer-prompt-'));
    expect(written).toEqual(['reviewer-prompt-stub.txt']);
    const prompt = readFileSync(join(promptDir, written[0]!), 'utf8');

    expect(prompt).toContain('Role-based cezar council criteria (run test).');
    expect(prompt).toContain('<review_packet>');
    expect(prompt).toContain('<review_subject>');
    expect(prompt).toContain('export const value = 2;');
    expect(prompt).toContain('<trusted_rubric>');
    expect(prompt).toContain('SOURCE: SKILL.md');
    expect(prompt).toContain('Canonical om-code-review skill body.');
    expect(prompt).toContain('SOURCE: review-checklist.md');
    expect(prompt).toContain('state-machine, retry, recovery, cancellation');
    expect(prompt).toContain('SOURCE: output-format.md');
    expect(prompt).toContain('mechanical approve or request-changes verdict');
    expect(prompt.length).toBeGreaterThan(1_000);
    expect(prompt.length).toBeLessThan(180_000);

    const council = JSON.parse(readFileSync(join(root, 'out', 'review-result.json'), 'utf8')) as {
      reviewers: Array<{ id: string; promptPath?: string }>;
    };
    expect(council.reviewers[0]?.promptPath).toBe(join(promptDir, 'reviewer-prompt-stub.txt'));
  });
});
