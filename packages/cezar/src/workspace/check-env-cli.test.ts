import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCheckEnvCommand } from './check-env-cli.ts';
import { registerProject } from './projects.ts';

describe('cezar check-env (spec 2026-10-06-agentic-e2e-checks Phase 1)', () => {
  let root: string;
  let lines: string[];
  let errors: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-check-env-cli-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    lines = [];
    errors = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[], value?: string) =>
    runCheckEnvCommand([...args, '--repo', root], {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      ...(value === undefined ? {} : { readValue: async () => value }),
    });

  it('sets from stdin, lists names and unsets — printing names, never values', async () => {
    await registerProject(root);
    expect(await cli(['set', 'E2E_KEY'], 'cli-secret-value')).toBe(0);
    expect(await cli(['list'])).toBe(0);
    expect(await cli(['unset', 'E2E_KEY'])).toBe(0);
    expect(await cli(['list'])).toBe(0);
    expect(lines).toEqual(['E2E_KEY', 'E2E_KEY', 'E2E_KEY']);
    expect([...lines, ...errors].join('\n')).not.toContain('cli-secret-value');
  });

  it('never takes a value from argv, and refuses any other operand shape', async () => {
    await registerProject(root);
    expect(await cli(['set', 'E2E_KEY', 'inline-value'])).toBe(1);
    expect(errors.join('\n')).toContain('Usage');
    for (const args of [[], ['list', 'EXTRA'], ['set'], ['unset'], ['nonsense']]) {
      expect(await cli(args)).toBe(1);
      expect(errors.at(-1)).toContain('Usage');
    }
  });

  it('refuses a reserved name and an unregistered folder, and reports a missing name', async () => {
    expect(await cli(['list'])).toBe(1);
    expect(errors.at(-1)).toContain('not a registered cezar project');
    await registerProject(root);
    expect(await cli(['set', 'CEZ_RUN_ID'], 'x')).toBe(1);
    expect(errors.at(-1)).toContain('reserved');
    expect(await cli(['unset', 'MISSING'])).toBe(1);
    expect(errors.at(-1)).toContain('no check credential named MISSING');
    expect(await cli(['set', 'E2E_KEY'], '')).toBe(1);
  });
});
