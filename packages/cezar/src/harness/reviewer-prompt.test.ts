import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * What an advisor reviewer is actually sent, and what cezar records about it.
 *
 * cezar hands the runtime a short criteria document and used to record THAT as
 * the invocation's prompt, so the cockpit's "Sent to the reviewer" showed seven
 * lines — task, validation gate, evidence hash — and reasonably read as "we
 * never gave this model the review rubric at all". The runtime had in fact
 * wrapped those lines in the review subject, the complete cez-code-review
 * rubric and the output contract. This pins both halves: the rubric really is
 * delivered, and the runtime now writes the assembled prompt somewhere the host
 * can show it.
 */

const RUNTIME = join(
  import.meta.dirname,
  '..',
  '..',
  'vendor',
  'skills',
  'cez-harness',
  'scripts',
  'harness.mjs',
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : error
          ? 1
          : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe('advisor reviewer prompt', () => {
  it('sends the full cez-code-review rubric and records the prompt it sent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-prompt-'));
    roots.push(root);
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
    // The review subject is the worktree's uncommitted diff.
    writeFileSync(join(worktree, 'app.ts'), 'export const value = 2;\n');

    // A stub reviewer: whatever it is sent, it approves. The point of the test
    // is the prompt file it leaves behind, not its judgement.
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

    // The criteria cezar passes in — exactly the shape the cockpit used to show
    // as the whole prompt.
    const criteriaPath = join(root, 'criteria.md');
    writeFileSync(
      criteriaPath,
      'Role-based cezar council criteria (run test).\n\nThe task under review: improve the inbox\n',
    );

    const promptDir = join(root, 'artifacts');
    const result = await run(
      process.execPath,
      [
        RUNTIME,
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
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const written = readdirSync(promptDir).filter((name) => name.startsWith('reviewer-prompt-'));
    expect(written).toEqual(['reviewer-prompt-stub.txt']);
    const prompt = readFileSync(join(promptDir, written[0]!), 'utf8');

    // The criteria are one section of the prompt, not the prompt.
    expect(prompt).toContain('Role-based cezar council criteria (run test).');
    expect(prompt).toContain('<review_packet>');
    // The subject under review.
    expect(prompt).toContain('<review_subject>');
    expect(prompt).toContain('export const value = 2;');
    // And the rubric that the seven-line view made look absent.
    expect(prompt).toContain('<trusted_rubric>');
    expect(prompt).toContain('SOURCE: SKILL.md');
    expect(prompt).toContain('SOURCE: review-checklist.md');
    expect(prompt).toContain('SOURCE: output-format.md');
    expect(prompt.length).toBeGreaterThan(5_000);

    // The runtime reports the path so the host can record it instead of the
    // criteria file it passed in.
    const council = JSON.parse(readFileSync(join(root, 'out', 'review-result.json'), 'utf8')) as {
      reviewers: Array<{ id: string; promptPath?: string }>;
    };
    expect(council.reviewers[0]?.promptPath).toBe(join(promptDir, 'reviewer-prompt-stub.txt'));
  });
});
