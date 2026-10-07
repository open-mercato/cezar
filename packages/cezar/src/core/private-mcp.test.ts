import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, writeClaudeMcpConfig } from './claude-cli-runner.ts';
import {
  acpMcpCapabilities,
  loadPrivateMcp,
  opencodeConfigContent,
  parsePrivateMcp,
  privateMcpPath,
  supportsPrivateMcp,
  toAcpMcpServers,
  toCodexConfigOverrides,
  type PrivateMcpServer,
} from './private-mcp.ts';
import { readConfigFile, writeConfigFile } from '../agent-config/files.ts';
import { findConfigFile } from '../agent-config/catalog.ts';

/** Spec 2026-10-07-private-project-mcp: one private file, translated per agent at launch. */

const FILE = JSON.stringify({
  mcpServers: {
    tracker: { command: 'npx', args: ['-y', 'tracker-mcp'], env: { TOKEN: 's3cret' } },
    docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } },
    legacy: { type: 'sse', url: 'https://sse.example.com/sse' },
  },
});

function servers(): PrivateMcpServer[] {
  return parsePrivateMcp(FILE).servers;
}

describe('parsePrivateMcp', () => {
  it('reads the .mcp.json shape and infers the transport', () => {
    const { servers: parsed, problems } = parsePrivateMcp(FILE);
    expect(problems).toEqual([]);
    expect(parsed).toEqual([
      { name: 'tracker', transport: 'stdio', command: 'npx', args: ['-y', 'tracker-mcp'], env: { TOKEN: 's3cret' }, headers: {} },
      { name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp', args: [], env: {}, headers: { Authorization: 'Bearer t' } },
      { name: 'legacy', transport: 'sse', url: 'https://sse.example.com/sse', args: [], env: {}, headers: {} },
    ]);
  });

  it('skips one bad server without dropping the rest', () => {
    const { servers: parsed, problems } = parsePrivateMcp(
      JSON.stringify({ mcpServers: { 'bad name': { command: 'x' }, nourl: { type: 'http' }, ok: { url: 'https://a.example/mcp' } } }),
    );
    expect(parsed.map((s) => s.name)).toEqual(['ok']);
    expect(parsed[0]?.transport).toBe('http');
    expect(problems).toHaveLength(2);
  });

  it('degrades a broken or empty file to no servers', () => {
    expect(parsePrivateMcp('').servers).toEqual([]);
    expect(parsePrivateMcp('{nope').problems[0]).toMatch(/not valid JSON/);
    expect(parsePrivateMcp('[]').problems[0]).toMatch(/mcpServers/);
  });
});

describe('loadPrivateMcp', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-private-mcp-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('an absent file is no servers and no problem', async () => {
    expect(await loadPrivateMcp(repo)).toEqual({ servers: [], problems: [] });
  });

  it('reads <repo>/.ai/cezar/mcp.local.json', async () => {
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(privateMcpPath(repo), FILE);
    expect((await loadPrivateMcp(repo)).servers.map((s) => s.name)).toEqual(['tracker', 'docs', 'legacy']);
  });
});

describe('per-agent translation', () => {
  it('claude: --mcp-config file is 0600, and the servers are allowed under dontAsk', () => {
    const config = writeClaudeMcpConfig(servers());
    expect(config).toBeDefined();
    try {
      expect(statSync(config!.path).mode & 0o777).toBe(0o600);
      const written = JSON.parse(readFileSync(config!.path, 'utf8'));
      expect(written.mcpServers.tracker).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'tracker-mcp'], env: { TOKEN: 's3cret' } });
      expect(written.mcpServers.docs).toMatchObject({ type: 'http', url: 'https://mcp.example.com/mcp' });

      const args = buildClaudeArgs({ userPrompt: 'x', cwd: '/r', allowedTools: ['Read'], mcpServers: servers() }, {}, config!.path);
      expect(args[args.indexOf('--mcp-config') + 1]).toBe(config!.path);
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,mcp__tracker,mcp__docs,mcp__legacy');
      // tokens never ride argv, where `ps` would show them
      expect(args.join(' ')).not.toContain('s3cret');
    } finally {
      config!.cleanup();
    }
    expect(existsSync(config!.path)).toBe(false);
  });

  it('claude: no servers → no flag and no file', () => {
    expect(writeClaudeMcpConfig([])).toBeUndefined();
    expect(buildClaudeArgs({ userPrompt: 'x', cwd: '/r' }, {})).not.toContain('--mcp-config');
  });

  it('codex: one dotted override per server; SSE is skipped', () => {
    const { config, skipped } = toCodexConfigOverrides(servers());
    expect(config).toEqual({
      'mcp_servers.tracker': { command: 'npx', args: ['-y', 'tracker-mcp'], env: { TOKEN: 's3cret' } },
      'mcp_servers.docs': { url: 'https://mcp.example.com/mcp', http_headers: { Authorization: 'Bearer t' } },
    });
    expect(skipped).toEqual(['legacy']);
  });

  it('opencode: local/remote entries merged into any inline config already set', () => {
    const content = JSON.parse(
      opencodeConfigContent(servers(), JSON.stringify({ model: 'a/b', mcp: { mine: { type: 'local', command: ['x'] } } })),
    );
    expect(content.model).toBe('a/b');
    expect(Object.keys(content.mcp)).toEqual(['mine', 'tracker', 'docs', 'legacy']);
    expect(content.mcp.tracker).toEqual({
      type: 'local',
      command: ['npx', '-y', 'tracker-mcp'],
      environment: { TOKEN: 's3cret' },
      enabled: true,
    });
    expect(content.mcp.legacy).toMatchObject({ type: 'remote', url: 'https://sse.example.com/sse' });
    expect(JSON.parse(opencodeConfigContent(servers(), '{broken')).mcp.docs.type).toBe('remote');
  });

  it('acp: stdio always; http/sse only when the agent advertised them', () => {
    const none = toAcpMcpServers(servers(), acpMcpCapabilities({ agentCapabilities: {} }));
    expect(none.mcpServers).toEqual([
      { name: 'tracker', command: 'npx', args: ['-y', 'tracker-mcp'], env: [{ name: 'TOKEN', value: 's3cret' }] },
    ]);
    expect(none.skipped).toEqual(['docs', 'legacy']);

    const all = toAcpMcpServers(servers(), acpMcpCapabilities({ agentCapabilities: { mcpCapabilities: { http: true, sse: true } } }));
    expect(all.skipped).toEqual([]);
    expect(all.mcpServers[1]).toEqual({
      type: 'http',
      name: 'docs',
      url: 'https://mcp.example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    });
  });

  it('cursor and pi have no launch-time channel', () => {
    expect(['claude', 'claude-cli', 'codex', 'opencode', 'junie', 'copilot'].filter(supportsPrivateMcp)).toEqual([
      'claude',
      'codex',
      'opencode',
      'junie',
      'copilot',
    ]);
    expect(supportsPrivateMcp('cursor')).toBe(false);
    expect(supportsPrivateMcp('pi')).toBe(false);
  });
});

describe('the cezar.private.mcp catalog file', () => {
  let repo: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cez-private-mcp-repo-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('is listed for every agent that can take it', () => {
    expect(findConfigFile('cezar.private.mcp')?.runners).toEqual(['claude', 'codex', 'opencode', 'junie', 'copilot']);
  });

  it('is written 0600 and is git-ignored even when a .mcp.json is committed', async () => {
    writeFileSync(join(repo, '.mcp.json'), '{"mcpServers":{}}');
    execFileSync('git', ['add', '.mcp.json'], { cwd: repo });

    const out = await writeConfigFile('cezar.private.mcp', FILE, null, repo, { HOME: repo });
    expect(out).toMatchObject({ ok: true });
    const path = privateMcpPath(repo);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await readConfigFile('cezar.private.mcp', repo, { HOME: repo })) as { content: string }).toMatchObject({ content: FILE });

    execFileSync('git', ['check-ignore', '-q', path], { cwd: repo }); // throws when not ignored
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status).not.toContain('mcp.local.json');
  });
});
