import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HarnessRuntime,
  exportTrustedConfig,
  loadAgenticConfig,
  resolveHarnessRuntimeInfo,
  resolveHarnessScript,
  runValidationCommands,
} from './runtime.js';

/**
 * The runtime bridge (spec Architecture §2): spawns the installed
 * `harness.mjs` with an argument array (never a shell), bounded by a timeout
 * and killable on cancel; exports the trusted config snapshot from the base
 * revision; and runs the repo's configured validation commands with real exit
 * codes as evidence. Tested against a stub script — the real `harness.mjs` is
 * the skills repo's contract, not this test's.
 */
describe('harness runtime bridge', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-harness-rt-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeStub = (body: string): string => {
    const script = join(dir, 'harness.mjs');
    writeFileSync(script, body, 'utf8');
    return script;
  };

  it('resolveHarnessRuntimeInfo reports the bundled collection with its pinned commit', async () => {
    // The real vendored tree (default bundledDir) — a packaged cezar always has it.
    const info = await resolveHarnessRuntimeInfo(dir);
    expect(info.installed).toBe(true);
    expect(info.source).toBe('bundled');
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('resolveHarnessRuntimeInfo degrades honestly when the collection is absent or scriptless', async () => {
    // No bundled dir, empty repo: not installed at all.
    const none = await resolveHarnessRuntimeInfo(dir, { bundledDir: null });
    expect(none).toEqual({ installed: false, source: null, commit: null });

    // A cez-harness skill without its runtime script: found but not installed.
    const fake = join(dir, 'fake-bundled');
    mkdirSync(join(fake, 'cez-harness'), { recursive: true });
    writeFileSync(join(fake, 'cez-harness', 'SKILL.md'), '---\nname: cez-harness\n---\nbody');
    const scriptless = await resolveHarnessRuntimeInfo(dir, { bundledDir: fake });
    expect(scriptless.installed).toBe(false);
    expect(scriptless.source).toBe('bundled');
  });

  it('resolveHarnessScript finds the materialized skill script or null', () => {
    expect(resolveHarnessScript(dir)).toBeNull();
    const scriptDir = join(dir, '.claude', 'skills', 'cez-harness', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, 'harness.mjs'), '// stub', 'utf8');
    expect(resolveHarnessScript(dir)).toBe(join(scriptDir, 'harness.mjs'));
  });

  it('run() reports exit code and output for a succeeding op', async () => {
    const script = writeStub('console.log("captured"); process.exit(0);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const result = await rt.run('capture', ['--worktree', dir]);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('captured');
  });

  it('run() reports failure with stderr for a non-zero op', async () => {
    const script = writeStub('console.error("refs moved"); process.exit(3);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const result = await rt.run('stage', []);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('refs moved');
  });

  it('run() kills an op that exceeds its timeout', async () => {
    const script = writeStub('setTimeout(() => {}, 60_000);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const result = await rt.run('probe', [], { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });

  it('kill() terminates a running op (the cancel path)', async () => {
    const script = writeStub('setTimeout(() => {}, 60_000);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const pending = rt.run('worker', []);
    await new Promise((r) => setTimeout(r, 100));
    rt.kill();
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it('runValidationCommands records real per-command evidence and stops on failure', async () => {
    const checks = await runValidationCommands(['echo ok', 'exit 2', 'echo never'], dir);
    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({ command: 'echo ok', status: 'passed', exitCode: 0 });
    expect(checks[1]).toMatchObject({ command: 'exit 2', status: 'failed', exitCode: 2 });
    // Commands after a failure are recorded as skipped, never silently absent.
    expect(checks[2]).toMatchObject({ command: 'echo never', status: 'skipped', exitCode: null });
  });

  it('loadAgenticConfig reads validation commands and tolerates absence', async () => {
    expect(await loadAgenticConfig(dir)).toEqual({ validationCommands: [], agentHarness: undefined, baseBranch: undefined });
    mkdirSync(join(dir, '.ai'), { recursive: true });
    writeFileSync(
      join(dir, '.ai', 'agentic.config.json'),
      JSON.stringify({ baseBranch: 'main', validation: { commands: ['npm test'] }, agentHarness: { version: 1 } }),
      'utf8',
    );
    const config = await loadAgenticConfig(dir);
    expect(config.validationCommands).toEqual(['npm test']);
    expect(config.baseBranch).toBe('main');
    expect(config.agentHarness).toEqual({ version: 1 });
  });

  describe('trusted config export', () => {
    it('exports .ai/agentic.config.json from the base revision, not the working tree', async () => {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      git('init', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      mkdirSync(join(dir, '.ai'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'agentic.config.json'), '{"committed": true}', 'utf8');
      git('add', '.');
      git('commit', '-m', 'base');
      // Working-tree drift after the commit must NOT leak into the snapshot.
      writeFileSync(join(dir, '.ai', 'agentic.config.json'), '{"committed": false}', 'utf8');

      const out = mkdtempSync(join(tmpdir(), 'cez-trusted-'));
      try {
        const snapshot = await exportTrustedConfig(dir, 'main', out);
        expect(snapshot).not.toBeNull();
        expect(JSON.parse(readFileSync(snapshot!.path, 'utf8'))).toEqual({ committed: true });
        expect(snapshot?.ref).toMatch(/^main@[0-9a-f]{7,}$/);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });

    it('returns null when the base revision has no config', async () => {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      git('init', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'x', 'utf8');
      git('add', '.');
      git('commit', '-m', 'base');
      const out = mkdtempSync(join(tmpdir(), 'cez-trusted-'));
      try {
        expect(await exportTrustedConfig(dir, 'main', out)).toBeNull();
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  });
});
