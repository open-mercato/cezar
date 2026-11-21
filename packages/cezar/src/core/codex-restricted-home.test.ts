import { symlinkSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRestrictedCodexHome, pruneRestrictedCodexHomes, restrictedCodexModelConfig } from './codex-restricted-home.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cez-isolated-codex-')); dirs.push(root);
  const native = join(root, 'native'); const cwd = join(root, 'repo'); const gh = join(root, 'gh');
  for (const p of [native, cwd, gh]) mkdirSync(p);
  const env = { CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native, GH_CONFIG_DIR: gh, GH_TOKEN: 'fake-gh', OPENAI_API_KEY: 'fake-model', NODE_OPTIONS: '--bad', CEZ_AGENT_ENV_FULL: '1' };
  return { root, native, cwd, gh, env };
}
describe.skipIf(process.platform === 'win32')('restricted Codex homes', () => {
  it('isolates execution settings and environment while preserving selected-account file auth', () => {
    const f = setup();
    writeFileSync(join(f.native, 'config.toml'), 'model="test"\napproval_policy="never"\n[features]\nhooks=true\n[mcp_servers.evil]\ncommand="evil"\n');
    writeFileSync(join(f.native, 'auth.json'), 'fake-auth');
    writeFileSync(join(f.gh, 'hosts.yml'), 'fake-gh-auth');
    mkdirSync(join(f.native, 'rules')); writeFileSync(join(f.native, 'rules', 'evil.rules'), 'allow everything');
    const home = prepareRestrictedCodexHome({ cwd: f.cwd }, f.env);
    expect(home.path).not.toBe(f.native);
    expect(home.config.approval_policy).toBe('never');
    expect(home.config.features).toMatchObject({ hooks: false, unified_exec_tty: false, apps: false, plugins: false, browser_use: false, computer_use: false, skill_mcp_dependency_install: false });
    expect(home.config.model).toBe('test');
    expect(home.config).not.toHaveProperty('mcp_servers');
    expect(existsSync(join(home.path, 'rules'))).toBe(false);
    expect(readlinkSync(join(home.path, 'auth.json'))).toBe(join(f.native, 'auth.json'));
    writeFileSync(join(home.path, 'auth.json'), 'refreshed-fake-auth');
    expect(readFileSync(join(f.native, 'auth.json'), 'utf8')).toBe('refreshed-fake-auth');
    expect(home.env).not.toHaveProperty('NODE_OPTIONS');
    expect(home.env).not.toHaveProperty('CEZ_AGENT_ENV_FULL');
    expect(home.env).not.toHaveProperty('GH_TOKEN');
    expect(home.env.OPENAI_API_KEY).toBe('fake-model');
    expect(home.toolEnv.GH_TOKEN).toBe('fake-gh');
    expect(home.toolEnv.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(prepareRestrictedCodexHome({ cwd: f.cwd }, f.env).path).toBe(home.path);
    const other = join(f.root, 'other'); mkdirSync(other);
    expect(prepareRestrictedCodexHome({ cwd: other }, f.env).path).not.toBe(home.path);
    expect(realpathSync(f.native)).not.toBe(home.path);
  });
  it('refuses a replaced isolated config symlink without overwriting its target', () => {
    const f = setup(); const home = prepareRestrictedCodexHome({ cwd: f.cwd }, f.env);
    const victim = join(f.root, 'victim'); writeFileSync(victim, 'keep');
    unlinkSync(join(home.path, 'config.toml')); symlinkSync(victim, join(home.path, 'config.toml'));
    expect(() => prepareRestrictedCodexHome({ cwd: f.cwd }, f.env)).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });
  it('copies only the selected model-provider transport settings', () => {
    const result = restrictedCodexModelConfig('model_provider="custom"\n[model_providers.custom]\nname="Custom"\nbase_url="http://127.0.0.1:1234"\nenv_key="MODEL_TOKEN"\n[model_providers.other]\ncommand="evil"');
    expect(result.authEnv).toEqual(['MODEL_TOKEN']);
    expect(result.config).not.toHaveProperty('model_providers.other');
    expect(() => restrictedCodexModelConfig('model_provider="x"\n[model_providers.x]\ncommand="evil"')).toThrow('unsupported');
    expect(() => restrictedCodexModelConfig('model_provider="x"\n[model_providers.x]\nenv_key="NODE_OPTIONS"')).toThrow('process controls');
  });
});

describe.skipIf(process.platform === 'win32')('restricted Codex home cleanup', () => {
  function managed() {
    const f = setup();
    const project = join(f.root, 'project');
    const cwd = join(project, '.ai', 'cezar', 'worktrees', 'gone');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(f.native, 'auth.json'), 'native-account');
    const home = prepareRestrictedCodexHome({ cwd }, f.env);
    mkdirSync(join(home.path, 'sessions'));
    writeFileSync(join(home.path, 'sessions', 'rollout.jsonl'), 'sensitive-history');
    return { ...f, project, cwd, home };
  }
  it.each([false, true])('prunes a missing orphan (legacy=%s) without deleting native credentials', legacy => {
    const f = managed();
    if (legacy) unlinkSync(join(f.home.path, 'owner.json'));
    rmSync(f.cwd, { recursive: true });
    expect(pruneRestrictedCodexHomes(f.project, new Set(), f.env)).toHaveLength(1);
    expect(existsSync(f.home.path)).toBe(false);
    expect(readFileSync(join(f.native, 'auth.json'), 'utf8')).toBe('native-account');
  });
  it('keeps existing worktrees and every retained task, including reclaimed tasks', () => {
    const f = managed();
    expect(pruneRestrictedCodexHomes(f.project, new Set(), f.env)).toEqual([]);
    rmSync(f.cwd, { recursive: true });
    expect(pruneRestrictedCodexHomes(f.project, new Set(['gone']), f.env)).toEqual([]);
    mkdirSync(f.cwd);
    expect(prepareRestrictedCodexHome({ cwd: f.cwd }, f.env).path).toBe(f.home.path);
    expect(readFileSync(join(f.home.path, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('sensitive-history');
  });
  it('keeps other projects and non-managed working directories', () => {
    const f = managed();
    const other = join(f.root, 'other-project'); mkdirSync(other);
    const ordinary = prepareRestrictedCodexHome({ cwd: f.root }, f.env);
    rmSync(f.cwd, { recursive: true });
    expect(pruneRestrictedCodexHomes(other, new Set(), f.env)).toEqual([]);
    expect(existsSync(f.home.path)).toBe(true);
    pruneRestrictedCodexHomes(f.project, new Set(), f.env);
    expect(existsSync(ordinary.path)).toBe(true);
  });
  it.each(['malformed', 'wrong-key', 'symlink', 'oversized', 'ambiguous-legacy'])('retains uncertain metadata: %s', mode => {
    const f = managed(); const marker = join(f.home.path, 'owner.json');
    rmSync(f.cwd, { recursive: true });
    if (mode === 'malformed') writeFileSync(marker, '{broken');
    if (mode === 'wrong-key') writeFileSync(marker, JSON.stringify({ version: 1, cwd: f.cwd, nativeHome: 'wrong' }));
    if (mode === 'symlink') { unlinkSync(marker); symlinkSync(join(f.native, 'auth.json'), marker); }
    if (mode === 'oversized') writeFileSync(marker, 'x'.repeat(65 * 1024));
    if (mode === 'ambiguous-legacy') {
      unlinkSync(marker);
      writeFileSync(join(f.home.path, 'config.toml'), '[projects.a]\ntrust_level="untrusted"\n[projects.b]\ntrust_level="untrusted"');
    }
    expect(pruneRestrictedCodexHomes(f.project, new Set(), f.env)).toEqual([]);
    expect(existsSync(f.home.path)).toBe(true);
  });
  it('does not follow a symlinked home or store', () => {
    const f = managed(); const moved = join(f.root, 'moved');
    rmSync(f.cwd, { recursive: true });
    renameSync(f.home.path, moved); symlinkSync(moved, f.home.path);
    expect(pruneRestrictedCodexHomes(f.project, new Set(), f.env)).toEqual([]);
    expect(readFileSync(join(moved, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('sensitive-history');
    unlinkSync(f.home.path);
    const homes = join(f.env.CEZ_HOME, 'codex-restricted');
    rmSync(homes, { recursive: true }); symlinkSync(moved, homes);
    expect(pruneRestrictedCodexHomes(f.project, new Set(), f.env)).toEqual([]);
    expect(existsSync(join(moved, 'sessions'))).toBe(true);
  });
  it('fails closed when the home is unavailable', () => {
    const f = setup();
    expect(pruneRestrictedCodexHomes(f.root, new Set(), f.env)).toEqual([]);
  });
});
