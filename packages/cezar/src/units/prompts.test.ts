import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNIT_ROLES, unitSpawnSchema } from '@open-mercato/cezar-contract';
import {
  DEFAULT_UNIT_PROMPTS,
  listUnitPrompts,
  resetUnitPrompt,
  resolveUnitPrompt,
  unitPromptsDir,
  writeUnitPrompt,
} from './prompts.ts';

/**
 * The role-prompt layer (spec 2026-09-08-units-hierarchy §Role prompts): a shipped default per
 * role, a per-repo override under `.ai/cezar/units/<role>.md`, and delete = restore.
 *
 * The default/file/restore cycle is the whole contract, plus one thing worth pinning that is not
 * about files at all: the prompts are the ONLY place an agent is told the marker payload shapes,
 * so a schema change that leaves them behind is a feature that silently stops working.
 */
describe('unit role prompts', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-unit-prompts-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('falls back to the default when no file exists — the zero-config path writes nothing', async () => {
    for (const role of UNIT_ROLES) {
      const resolved = await resolveUnitPrompt(repoRoot, role);
      expect(resolved.source).toBe('default');
      expect(resolved.text).toBe(DEFAULT_UNIT_PROMPTS[role]);
    }
    // No read ever creates the directory — a repo that never edits a prompt grows no state.
    expect(existsSync(unitPromptsDir(repoRoot))).toBe(false);
  });

  it('reads a per-repo override and reports it as `file`', async () => {
    await writeUnitPrompt(repoRoot, 'caesar', 'You are a very small caesar.');
    const resolved = await resolveUnitPrompt(repoRoot, 'caesar');
    expect(resolved).toEqual({ text: 'You are a very small caesar.', source: 'file' });
    // The other roles are untouched — one override is one role.
    expect((await resolveUnitPrompt(repoRoot, 'legate')).source).toBe('default');
  });

  it('creates the directory on write and leaves no .tmp behind', async () => {
    await writeUnitPrompt(repoRoot, 'centurion', 'hold the line');
    expect(await readFile(join(unitPromptsDir(repoRoot), 'centurion.md'), 'utf8')).toBe('hold the line');
    await expect(readFile(join(unitPromptsDir(repoRoot), 'centurion.md.tmp'), 'utf8')).rejects.toThrow();
  });

  it('overwrites an existing override rather than appending to it', async () => {
    await writeUnitPrompt(repoRoot, 'legate', 'first');
    await writeUnitPrompt(repoRoot, 'legate', 'second');
    expect((await resolveUnitPrompt(repoRoot, 'legate')).text).toBe('second');
  });

  it('restores the default on reset, and resetting twice is not an error', async () => {
    await writeUnitPrompt(repoRoot, 'legate', 'custom');
    expect((await resolveUnitPrompt(repoRoot, 'legate')).source).toBe('file');
    await resetUnitPrompt(repoRoot, 'legate');
    expect(await resolveUnitPrompt(repoRoot, 'legate')).toEqual({
      text: DEFAULT_UNIT_PROMPTS.legate,
      source: 'default',
    });
    await expect(resetUnitPrompt(repoRoot, 'legate')).resolves.toBeUndefined();
    await expect(resetUnitPrompt(repoRoot, 'caesar')).resolves.toBeUndefined();
  });

  it('treats a blank override as absent — an empty file is what a failed save looks like', async () => {
    await writeUnitPrompt(repoRoot, 'caesar', '   \n\n');
    expect((await resolveUnitPrompt(repoRoot, 'caesar')).source).toBe('default');
  });

  it('degrades to the default with one warning when the override is unreadable', async () => {
    // A directory where the file should be: readFile fails with EISDIR, not ENOENT.
    mkdirSync(join(unitPromptsDir(repoRoot), 'caesar.md'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = await resolveUnitPrompt(repoRoot, 'caesar');
    expect(resolved.source).toBe('default');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('lists every role, in order, mixing defaults and overrides', async () => {
    await writeUnitPrompt(repoRoot, 'centurion', 'mine');
    const prompts = await listUnitPrompts(repoRoot);
    expect(prompts.map((p) => p.role)).toEqual([...UNIT_ROLES]);
    expect(prompts.map((p) => p.source)).toEqual(['default', 'default', 'file']);
  });

  it('a hand-written file cezar never wrote is read the same way', async () => {
    mkdirSync(unitPromptsDir(repoRoot), { recursive: true });
    writeFileSync(join(unitPromptsDir(repoRoot), 'legate.md'), 'hand written', 'utf8');
    expect(await resolveUnitPrompt(repoRoot, 'legate')).toEqual({ text: 'hand written', source: 'file' });
  });

  describe('the defaults themselves', () => {
    it('ships one for every role', () => {
      expect(Object.keys(DEFAULT_UNIT_PROMPTS).sort()).toEqual([...UNIT_ROLES].sort());
      for (const role of UNIT_ROLES) expect(DEFAULT_UNIT_PROMPTS[role].length).toBeGreaterThan(500);
    });

    it('teaches every marker the turn-end engine parses', () => {
      for (const role of ['caesar', 'legate'] as const) {
        expect(DEFAULT_UNIT_PROMPTS[role]).toContain('CEZ:SPAWN');
        expect(DEFAULT_UNIT_PROMPTS[role]).toContain('CEZ:MONITORING');
      }
      for (const role of UNIT_ROLES) {
        expect(DEFAULT_UNIT_PROMPTS[role]).toContain('CEZ:REPORT');
        expect(DEFAULT_UNIT_PROMPTS[role]).toContain('CEZ:ASK');
        expect(DEFAULT_UNIT_PROMPTS[role]).toContain('CEZ:DONE');
      }
    });

    it('tells the centurion it dispatches sub-agents and never spawns', () => {
      expect(DEFAULT_UNIT_PROMPTS.centurion).toContain('must NOT use CEZ:SPAWN');
      expect(DEFAULT_UNIT_PROMPTS.centurion).toMatch(/sub-agent/i);
      // The backends without a sub-agent tool are named as a supported case, not a failure.
      expect(DEFAULT_UNIT_PROMPTS.centurion).toContain('no sub-agent tool');
    });

    it('tells the two commanding roles not to edit files themselves', () => {
      for (const role of ['caesar', 'legate'] as const) {
        expect(DEFAULT_UNIT_PROMPTS[role]).toMatch(/do not edit files yourself/i);
      }
    });

    it('carries the Guard rule in every role — it must not weaken down the ranks', () => {
      for (const role of UNIT_ROLES) {
        const prompt = DEFAULT_UNIT_PROMPTS[role];
        expect(prompt).toContain('Never work around a blocked action');
        expect(prompt).toMatch(/draft/i);
        expect(prompt).toMatch(/never merge/i);
      }
    });

    it('leaves the child-branch rule for the engine to fill in, in both commanding prompts', () => {
      expect(DEFAULT_UNIT_PROMPTS.caesar).toContain('{{CHILD_BRANCH_RULE}}');
      expect(DEFAULT_UNIT_PROMPTS.legate).toContain('{{CHILD_BRANCH_RULE}}');
      // The centurion never merges anything, so it has no branch rule to fill.
      expect(DEFAULT_UNIT_PROMPTS.centurion).not.toContain('{{CHILD_BRANCH_RULE}}');
    });

    /**
     * The regression that matters most here. The prompts restate `unitSpawnSchema` in prose, so
     * this parses the EXAMPLE payload they teach against the real schema: a key renamed in the
     * contract and forgotten in the prompt would otherwise ship as an agent confidently emitting
     * a payload cez refuses.
     */
    it('teaches a CEZ:SPAWN example the real schema accepts', () => {
      for (const role of ['caesar', 'legate'] as const) {
        const line = DEFAULT_UNIT_PROMPTS[role].match(/CEZ:SPAWN (\{.*\})/)?.[1];
        expect(line, `${role} prompt has no CEZ:SPAWN example`).toBeDefined();
        const parsed = unitSpawnSchema.safeParse(JSON.parse(line!));
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
    });

    it('names every optional spawn key the schema accepts', () => {
      for (const key of ['scope', 'allowed_tools', 'max_cost', 'success_criteria', 'required_evidence', 'retry_limit']) {
        expect(DEFAULT_UNIT_PROMPTS.caesar).toContain(key);
      }
    });
  });
});
