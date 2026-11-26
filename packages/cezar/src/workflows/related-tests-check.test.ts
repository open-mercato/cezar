import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnCheck } from './check-process.ts';
import { BUILT_IN_GRAPH_WORKFLOWS, IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR, RELATED_TESTS_COMMAND } from './templates.ts';

/** The built-in `Run tests` check runs the agent's recorded related-tests command, else the suite. */
describe('built-in related-tests check', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-related-tests-'));
    file = join(dir, '.test-command');
    // The "whole suite" of this fake repo: `npm test` prints a marker we can look for.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'echo WHOLE-SUITE' } }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runCheck = (env: Record<string, string | undefined>) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const base = { ...process.env };
      delete base.CEZ_TEST_COMMAND_FILE;
      const child = spawnCheck(RELATED_TESTS_COMMAND, dir, { ...base, ...env });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('close', (code) => resolve({ code, output }));
    });

  it('runs the recorded command instead of the whole suite', async () => {
    writeFileSync(file, 'echo RELATED-ONLY\n');
    const { code, output } = await runCheck({ CEZ_TEST_COMMAND_FILE: file });
    expect(code).toBe(0);
    expect(output).toContain('RELATED-ONLY');
    expect(output).not.toContain('WHOLE-SUITE');
  }, 20_000);

  it('fails with the recorded command, so the fixer loop still runs on red', async () => {
    writeFileSync(file, 'exit 3\n');
    expect((await runCheck({ CEZ_TEST_COMMAND_FILE: file })).code).toBe(3);
  }, 20_000);

  it('fails when any line of a multi-line record fails, not only the last', async () => {
    writeFileSync(file, 'false\necho after\n');
    expect((await runCheck({ CEZ_TEST_COMMAND_FILE: file })).code).not.toBe(0);
  }, 20_000);

  // A recorded `… 2>&1 | tail -40` must not exit with `tail`'s status (review of #2519).
  it('fails when a stage of a recorded pipeline fails', async () => {
    writeFileSync(file, 'false | cat\n');
    expect((await runCheck({ CEZ_TEST_COMMAND_FILE: file })).code).not.toBe(0);
  }, 20_000);

  it('prints the recorded command before running it, so a reviewer sees what ran', async () => {
    writeFileSync(file, 'echo RELATED-ONLY\n');
    const { output } = await runCheck({ CEZ_TEST_COMMAND_FILE: file });
    expect(output).toContain(`Related-tests command recorded by the agent (${file}):\n  | echo RELATED-ONLY`);
  }, 20_000);

  it('names the variable, not an empty path, when it falls back', async () => {
    const { output } = await runCheck({});
    expect(output).toContain('No related-tests command recorded in $CEZ_TEST_COMMAND_FILE: running the whole suite (npm test).');
  }, 20_000);

  it.each([
    ['the file is absent', () => ({ CEZ_TEST_COMMAND_FILE: join(dir, 'missing') })],
    ['the file is empty', () => (writeFileSync(file, ''), { CEZ_TEST_COMMAND_FILE: file })],
    ['the file holds only blank lines', () => (writeFileSync(file, '\n  \n\t\n'), { CEZ_TEST_COMMAND_FILE: file })],
    ['the file holds only comments', () => (writeFileSync(file, '# npm test -- a.test.ts\n  # nothing\n'), { CEZ_TEST_COMMAND_FILE: file })],
    ['the variable is unset', () => ({})],
  ])('falls back to the whole suite when %s', async (_label, setup) => {
    const { code, output } = await runCheck(setup());
    expect(code).toBe(0);
    expect(output).toContain('WHOLE-SUITE');
  }, 20_000);

  it('is what both implement templates check with, and their agents are told to record the command', () => {
    for (const [workflow, agents] of [[IMPLEMENT_AND_VERIFY, ['implement', 'fix']], [IMPLEMENT_REVIEW_PR, ['implement', 'fix', 'address']]] as const) {
      const nodes = workflow.graph!.nodes;
      expect(nodes.find((n) => n.id === 'tests')).toMatchObject({ type: 'check', command: RELATED_TESTS_COMMAND });
      for (const id of agents) {
        expect((nodes.find((n) => n.id === id) as { prompt: string }).prompt).toContain('$CEZ_TEST_COMMAND_FILE');
      }
    }
  });

  it('shows the recorded command at the implement-review-pr gate', () => {
    const gate = IMPLEMENT_REVIEW_PR.graph!.nodes.find((n) => n.id === 'gate') as { message: string };
    expect(gate.message).toContain('{{nodes.tests.recordedTests}}');
  });

  it('leaves no built-in check running a bare whole-suite command', () => {
    for (const workflow of BUILT_IN_GRAPH_WORKFLOWS) {
      for (const node of workflow.graph!.nodes) {
        if (node.type === 'check') expect(node.command).toBe(RELATED_TESTS_COMMAND);
      }
    }
  });
});
