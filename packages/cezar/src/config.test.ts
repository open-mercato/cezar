import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SKILLS_REPOS, gatedSkillsRepos, loadConfig, resolveWorktreeRetention } from './config.ts';

/**
 * `config.json` schema roundtrips (R2 2.3: `systemPrompt?`). The invariants
 * under test: the key is additive (old files keep loading exactly as before),
 * a bad value degrades per-key instead of discarding the whole config, and
 * the value is trimmed with blank treated as unset.
 */
describe('loadConfig systemPrompt', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-config-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const write = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');

  it('is undefined when no config file exists (zero-config default)', async () => {
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
  });

  it('old config files without the key still load unchanged (additive proof)', async () => {
    write({ maxParallel: 5, defaultRunner: 'codex', baseBranch: 'develop' });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(5);
    expect(config.defaultRunner).toBe('codex');
    expect(config.baseBranch).toBe('develop');
  });

  it('roundtrips a configured prompt, trimmed', async () => {
    write({ systemPrompt: '  Always answer in Polish.  ' });
    expect((await loadConfig(repoRoot)).systemPrompt).toBe('Always answer in Polish.');
  });

  it('treats a whitespace-only prompt as unset without touching other keys', async () => {
    write({ systemPrompt: '   ', maxParallel: 3 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(3);
  });

  it('degrades an over-long prompt (>20k) to unset per-key, keeping the rest', async () => {
    write({ systemPrompt: 'x'.repeat(20_001), maxParallel: 4 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(4);
  });

  it('accepts a prompt at exactly the 20k cap', async () => {
    write({ systemPrompt: 'x'.repeat(20_000) });
    expect((await loadConfig(repoRoot)).systemPrompt).toHaveLength(20_000);
  });

  it('degrades a wrong-typed prompt to unset per-key, keeping the rest', async () => {
    write({ systemPrompt: 42, maxParallel: 6 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(6);
  });

  it('malformed JSON degrades to the full default (never throws)', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{not json', 'utf8');
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(2);
  });

  /** `defaultModels?` (R6 1.5) rides the same additive-key rules as `systemPrompt`. */
  describe('defaultModels', () => {
    it('is undefined when absent — old config files load unchanged', async () => {
      write({ maxParallel: 5 });
      const config = await loadConfig(repoRoot);
      expect(config.defaultModels).toBeUndefined();
      expect(config.maxParallel).toBe(5);
    });

    it('round-trips per-runner presets, trimmed', async () => {
      write({ defaultModels: { claude: ' opus ', opencode: 'openai/gpt-5.1' } });
      expect((await loadConfig(repoRoot)).defaultModels).toEqual({
        claude: 'opus',
        opencode: 'openai/gpt-5.1',
      });
    });

    it('degrades a bad value to unset per-key, keeping the rest of the config', async () => {
      write({ defaultModels: { claude: 42 }, maxParallel: 6 });
      const config = await loadConfig(repoRoot);
      expect(config.defaultModels).toBeUndefined();
      expect(config.maxParallel).toBe(6);
    });
  });

  describe('modelsLocked', () => {
    it('is optional and preserves only boolean values', async () => {
      expect((await loadConfig(repoRoot)).modelsLocked).toBeUndefined();

      write({ modelsLocked: true });
      expect((await loadConfig(repoRoot)).modelsLocked).toBe(true);

      write({ modelsLocked: 'yes', defaultRunner: 'codex' });
      const config = await loadConfig(repoRoot);
      expect(config.modelsLocked).toBeUndefined();
      expect(config.defaultRunner).toBe('codex');
    });
  });

  /** `worktreeRetention` (#483): count-based, always materialized (default 10),
   *  `.catch(10)` so a bad value degrades to the default. `0` = unlimited. */
  describe('worktreeRetention', () => {
    it('defaults to 10 when absent (old config files load unchanged)', async () => {
      write({ maxParallel: 5 });
      const config = await loadConfig(repoRoot);
      expect(config.worktreeRetention).toBe(10);
      expect(config.maxParallel).toBe(5);
    });

    it('round-trips a configured count', async () => {
      write({ worktreeRetention: 3 });
      expect((await loadConfig(repoRoot)).worktreeRetention).toBe(3);
    });

    it('keeps 0 as a meaningful value (unlimited)', async () => {
      write({ worktreeRetention: 0 });
      expect((await loadConfig(repoRoot)).worktreeRetention).toBe(0);
    });

    it('degrades a bad value to the default (10) via .catch', async () => {
      write({ worktreeRetention: -4, maxParallel: 6 });
      const config = await loadConfig(repoRoot);
      expect(config.worktreeRetention).toBe(10);
      expect(config.maxParallel).toBe(6);
    });

    it('degrades a wrong-typed value to the default (10)', async () => {
      write({ worktreeRetention: 'lots' });
      expect((await loadConfig(repoRoot)).worktreeRetention).toBe(10);
    });
  });
});

/**
 * `resolveWorktreeRetention` — what every enforcement site (boot sweeps,
 * terminal transitions, the reclaim route) asks instead of reading the parsed
 * `worktreeRetention`. The workspace's `resources.worktreeRetentionDefault`
 * only *seeds* repos that set none, which is exactly what Settings → Worktrees
 * tells the user, so the precedence is the contract under test here.
 */
describe('resolveWorktreeRetention', () => {
  let repoRoot: string;
  let cezHome: string;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retention-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // Pinned so the suite never reads (or writes) the developer's real ~/.cezar.
    cezHome = mkdtempSync(join(tmpdir(), 'cez-home-'));
    process.env.CEZ_HOME = cezHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  const writeRepo = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  const writeWorkspace = (value: unknown) =>
    writeFileSync(join(cezHome, 'config.json'), JSON.stringify(value), 'utf8');

  it('inherits the workspace default when the repo sets nothing', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: 4 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(4);
  });

  it('inherits it when the repo has no config file at all', async () => {
    rmSync(join(repoRoot, '.ai/cezar'), { recursive: true, force: true });
    writeWorkspace({ resources: { worktreeRetentionDefault: 7 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(7);
  });

  it('inherits 0 (unlimited) — the workspace default is a value, not a truthiness test', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: 0 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(0);
  });

  it("keeps the repo's own value, workspace default ignored", async () => {
    writeRepo({ worktreeRetention: 3 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 99 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(3);
  });

  it('keeps a repo value that happens to equal the historical default (10 is not a sentinel)', async () => {
    writeRepo({ worktreeRetention: 10 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 2 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(10);
  });

  it("keeps the repo's explicit 0 over the workspace default", async () => {
    writeRepo({ worktreeRetention: 0 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 5 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(0);
  });

  it('falls back to 10 when the workspace config is absent', async () => {
    writeRepo({ maxParallel: 5 });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(10);
  });

  it('falls back to 10 when the workspace config is corrupt (unreadable)', async () => {
    writeFileSync(join(cezHome, 'config.json'), '{ not json', 'utf8');
    expect(await resolveWorktreeRetention(repoRoot)).toBe(10);
  });

  it('falls back to 10 when the workspace default itself is out of bounds', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: -1 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(10);
  });

  it('treats a repo value the schema would refuse as unset, so the workspace seeds it', async () => {
    writeRepo({ worktreeRetention: 'lots' });
    writeWorkspace({ resources: { worktreeRetentionDefault: 6 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(6);
  });

  it('treats a malformed repo config as unset', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{ nope', 'utf8');
    writeWorkspace({ resources: { worktreeRetentionDefault: 8 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(8);
  });
});

/**
 * `gatedSkillsRepos` decides which repos are opt-in per skill (the "Import skills" flow). The
 * invariant: the vendor default (`open-mercato/skills`) is gated for the zero-config majority,
 * and a repo that sets its OWN `skillsRepos` gates nothing (it took control — everything it lists
 * auto-loads). Detection must probe the raw file because the schema's `.default()` erases the
 * "did the user set this?" distinction — the same reason `resolveWorktreeRetention` probes it.
 */
describe('gatedSkillsRepos', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gate-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const write = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');

  const defaults = DEFAULT_SKILLS_REPOS.map((r) => r.repo);

  it('gates the vendor defaults when there is no config file (zero-config)', async () => {
    expect([...(await gatedSkillsRepos(repoRoot))]).toEqual(defaults);
  });

  it('gates the vendor defaults when the config omits skillsRepos (additive)', async () => {
    write({ maxParallel: 4 });
    expect([...(await gatedSkillsRepos(repoRoot))]).toEqual(defaults);
  });

  it('gates nothing once the repo sets its own skillsRepos', async () => {
    write({ skillsRepos: [{ repo: 'acme/team-skills', ref: 'main' }] });
    expect((await gatedSkillsRepos(repoRoot)).size).toBe(0);
  });

  it('gates nothing even when skillsRepos is set to empty (an explicit opt-out)', async () => {
    write({ skillsRepos: [] });
    expect((await gatedSkillsRepos(repoRoot)).size).toBe(0);
  });

  it('degrades a malformed config to the vendor defaults (like loadConfig)', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{ nope', 'utf8');
    expect([...(await gatedSkillsRepos(repoRoot))]).toEqual(defaults);
  });
});

/**
 * Machine-wide agent defaults (spec 2026-07-29-agent-profiles): what a repo that has set none of
 * its own runs, so a second login and a model preference are configured once instead of per
 * checkout.
 *
 * The load-bearing property is that these are DEFAULTS. A repo key always wins, and the fallback is
 * applied to the RAW object before parsing — `defaultRunner`'s `.default('claude')` materializes the
 * key, so after a parse there is no telling "the user chose claude" from "the user said nothing".
 */
describe('loadConfig machine-wide agent defaults', () => {
  let repoRoot: string;
  let cezHome: string;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-machine-defaults-'));
    cezHome = mkdtempSync(join(tmpdir(), 'cez-machine-home-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = cezHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    for (const dir of [repoRoot, cezHome]) rmSync(dir, { recursive: true, force: true });
  });

  const writeRepo = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  const writeMachine = (agentDefaults: unknown) =>
    writeFileSync(join(cezHome, 'config.json'), JSON.stringify({ agentDefaults }), 'utf8');

  it('fills a repo that has no config file at all', async () => {
    writeMachine({ runner: 'codex', models: { codex: 'gpt-5' } });
    const config = await loadConfig(repoRoot);
    expect(config.defaultRunner).toBe('codex');
    expect(config.defaultModels?.codex).toBe('gpt-5');
  });

  it('fills a repo whose config says nothing about the runner', async () => {
    writeMachine({ runner: 'codex' });
    writeRepo({ systemPrompt: 'be brief' });
    expect((await loadConfig(repoRoot)).defaultRunner).toBe('codex');
  });

  it('NEVER overrules a repo that chose — that is what makes it a default', async () => {
    writeMachine({ runner: 'codex' });
    writeRepo({ defaultRunner: 'claude' });
    expect((await loadConfig(repoRoot)).defaultRunner).toBe('claude');
  });

  it('merges models per RUNNER, so pinning one does not discard the others', async () => {
    // Whole-object precedence would silently drop the machine's codex preset the moment a repo
    // pinned claude's — a loss nobody asked for and nothing would report.
    writeMachine({ models: { claude: 'machine-claude', codex: 'machine-codex' } });
    writeRepo({ defaultModels: { claude: 'repo-claude' } });
    const config = await loadConfig(repoRoot);
    expect(config.defaultModels).toEqual({ claude: 'repo-claude', codex: 'machine-codex' });
  });

  it('changes nothing when the machine has no opinion — the zero-config path', async () => {
    writeRepo({ systemPrompt: 'be brief' });
    const config = await loadConfig(repoRoot);
    expect(config.defaultRunner).toBe('claude');
    expect(config.defaultModels).toBeUndefined();
  });

  it('degrades to the built-in default when the machine file is corrupt', async () => {
    writeFileSync(join(cezHome, 'config.json'), '{not json', 'utf8');
    expect((await loadConfig(repoRoot)).defaultRunner).toBe('claude');
  });

  it('ignores a machine runner the schema refuses, rather than failing the load', async () => {
    writeMachine({ runner: 'not-an-agent' });
    writeRepo({ systemPrompt: 'be brief' });
    const config = await loadConfig(repoRoot);
    expect(config.defaultRunner).toBe('claude');
    expect(config.systemPrompt).toBe('be brief');
  });
});
