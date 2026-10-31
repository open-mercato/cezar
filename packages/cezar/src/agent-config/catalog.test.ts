import { describe, expect, it } from 'vitest';
import { CONFIG_FILES, findConfigFile, listConfigFiles, type AgentHomePaths } from './catalog.ts';

const HOME: AgentHomePaths = {
  claude: '/home/u/.claude',
  codex: '/home/u/.codex',
  opencodeConfig: '/home/u/.config/opencode',
  cursor: '/home/u/.cursor',
  copilot: '/home/u/.copilot',
  junie: '/home/u/.junie',
  pi: '/home/u/.pi/agent',
};

describe('agent-config catalog', () => {
  it('every id is unique and URL-safe', () => {
    const ids = CONFIG_FILES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9.]+$/);
  });

  it('every entry carries a non-empty precedence string and a docs URL', () => {
    for (const f of CONFIG_FILES) {
      expect(f.precedence.trim().length).toBeGreaterThan(0);
      expect(f.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('<repo>/AGENTS.md is ONE entry read by every runner that reads it', () => {
    const agents = CONFIG_FILES.filter((f) => f.label === 'AGENTS.md' && f.scope === 'project');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runners).toEqual(['codex', 'opencode', 'copilot', 'pi']);
  });

  it('resolves repo-relative paths under the repo root', () => {
    const proj = findConfigFile('claude.project.settings')!;
    expect(proj.resolve('/repo', HOME)).toBe('/repo/.claude/settings.json');
  });

  it('honours the injected home dirs (so $CODEX_HOME / $XDG_CONFIG_HOME / $CURSOR_CONFIG_DIR flow through)', () => {
    expect(findConfigFile('codex.user.config')!.resolve('/repo', HOME)).toBe('/home/u/.codex/config.toml');
    expect(findConfigFile('opencode.user.config')!.resolve('/repo', HOME)).toBe(
      '/home/u/.config/opencode/opencode.json',
    );
    expect(findConfigFile('claude.user.settings')!.resolve('/repo', HOME)).toBe('/home/u/.claude/settings.json');
    expect(findConfigFile('cursor.user.settings')!.resolve('/repo', HOME)).toBe(
      '/home/u/.cursor/cli-config.json',
    );
    expect(findConfigFile('cursor.project.settings')!.resolve('/repo', HOME)).toBe('/repo/.cursor/cli.json');
    expect(findConfigFile('cursor.user.mcp')!.resolve('/repo', HOME)).toBe('/home/u/.cursor/mcp.json');
    expect(findConfigFile('cursor.project.mcp')!.resolve('/repo', HOME)).toBe('/repo/.cursor/mcp.json');
    expect(findConfigFile('pi.user.settings')!.resolve('/repo', HOME)).toBe('/home/u/.pi/agent/settings.json');
    expect(findConfigFile('pi.project.settings')!.resolve('/repo', HOME)).toBe('/repo/.pi/settings.json');
    expect(findConfigFile('pi.user.memory')!.resolve('/repo', HOME)).toBe('/home/u/.pi/agent/AGENTS.md');
  });

  it('marks only Claude’s gitignored personal layer as seeded', () => {
    const seeded = CONFIG_FILES.filter((f) => f.seeded).map((f) => f.id).sort();
    expect(seeded).toEqual(['claude.local.memory', 'claude.local.settings']);
    for (const f of CONFIG_FILES) {
      if (f.seeded) expect(f.tracked).toBe('gitignored');
    }
  });

  it('every seeded/gitignored file is a repo-relative path (never in $HOME)', () => {
    for (const f of CONFIG_FILES) {
      if (f.tracked === 'gitignored') expect(f.resolve('/repo', HOME).startsWith('/repo/')).toBe(true);
    }
  });

  it('holdsMcp is set exactly where MCP servers actually live', () => {
    const mcp = CONFIG_FILES.filter((f) => f.holdsMcp).map((f) => f.id).sort();
    expect(mcp).toEqual([
      // cezar's own private, per-project servers (spec 2026-10-07-private-project-mcp).
      'cezar.private.mcp',
      'claude.project.mcp',
      'codex.project.config',
      'codex.user.config',
      // Copilot keeps MCP in its own file rather than inside its settings, like Claude.
      'copilot.user.mcp',
      'cursor.project.mcp',
      'cursor.user.mcp',
      'opencode.project.config',
      'opencode.user.config',
    ]);
  });

  it('listConfigFiles returns the table; findConfigFile is undefined for junk', () => {
    expect(listConfigFiles().length).toBe(CONFIG_FILES.length);
    expect(findConfigFile('../../etc/passwd')).toBeUndefined();
    expect(findConfigFile('nope')).toBeUndefined();
  });

  it('catalogues Pi settings and shared instructions, never Pi credentials or MCP state', () => {
    const pi = CONFIG_FILES.filter((f) => f.runners.includes('pi'));
    expect(pi.map((f) => f.id)).toEqual(['pi.user.settings', 'pi.project.settings', 'pi.user.memory', 'project.agents']);
    expect(pi.filter((f) => f.holdsMcp)).toHaveLength(0);
    expect(pi.some((f) => f.id.includes('auth') || f.id.includes('models'))).toBe(false);
  });
});
