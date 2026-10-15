import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeMcpGrants, grantsFromTools, learnMcpGrants, mcpServerGrant, parseMcpList, resetClaudeMcpGrantsForTest } from './claude-mcp.ts';

const LIST = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Google Cloud BigQuery: https://bigquery.googleapis.com/mcp - ✔ Connected
claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication
playwright: npx @playwright/mcp@latest - ✔ Connected
`;

beforeEach(() => {
  // The suite's setup turns discovery off; these cases are about discovery.
  vi.stubEnv('CEZ_MCP_TOOLS', '');
});

afterEach(() => {
  resetClaudeMcpGrantsForTest();
  vi.unstubAllEnvs();
});

describe('naming MCP servers for --allowedTools', () => {
  it('spells a server the way Claude prefixes its tools', () => {
    // Verified live: `mcp__claude_ai_Google_Cloud_BigQuery` admits `…__list_dataset_ids`; `mcp__*` admits nothing.
    expect(mcpServerGrant('claude.ai Google Cloud BigQuery')).toBe('mcp__claude_ai_Google_Cloud_BigQuery');
    expect(mcpServerGrant('my-server_2')).toBe('mcp__my-server_2');
  });

  it('reads every server `claude mcp list` names, whatever its health', () => {
    expect(parseMcpList(LIST)).toEqual([
      'claude.ai Claude Docs',
      'claude.ai Google Cloud BigQuery',
      'claude.ai Notion',
      'playwright',
    ]);
  });

  it('derives the server grant from a session’s own tool names', () => {
    expect(grantsFromTools(['Read', 'mcp__claude_ai_Gmail__send', 'mcp__claude_ai_Gmail__search', 'mcp__repo_db__query']))
      .toEqual(['mcp__claude_ai_Gmail', 'mcp__repo_db']);
  });
});

describe('claudeMcpGrants', () => {
  it('discovers once per project and serves the cache after', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    const list = vi.fn(async () => LIST);
    const first = await claudeMcpGrants('/repo', {}, { list });
    expect(first).toEqual([
      'mcp__claude_ai_Claude_Docs',
      'mcp__claude_ai_Google_Cloud_BigQuery',
      'mcp__claude_ai_Notion',
      'mcp__playwright',
    ]);
    await claudeMcpGrants('/repo', {}, { list });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('adds what sessions reported, so a repo’s own server is granted from the next session', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    learnMcpGrants(['mcp__repo_db__query']);
    expect(await claudeMcpGrants('/repo', {}, { list: async () => '' })).toEqual(['mcp__repo_db']);
  });

  it('never holds a run on a hung discovery', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    const started = Date.now();
    expect(await claudeMcpGrants('/repo', {}, { list: () => new Promise(() => {}), waitMs: 20 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('degrades to nothing when claude cannot list, and asks again later', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    expect(await claudeMcpGrants('/repo', {}, { list: async () => { throw new Error('ENOENT'); } })).toEqual([]);
  });

  it('is off with CEZ_MCP_TOOLS=0', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    vi.stubEnv('CEZ_MCP_TOOLS', '0');
    const list = vi.fn(async () => LIST);
    expect(await claudeMcpGrants('/repo', {}, { list })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps an account’s servers apart from the default account’s', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    const list = vi.fn(async (_cwd: string, env: NodeJS.ProcessEnv) => (env.CLAUDE_CONFIG_DIR ? 'work: https://w - ✔ Connected\n' : LIST));
    await claudeMcpGrants('/repo', {}, { list });
    expect(await claudeMcpGrants('/repo', { CLAUDE_CONFIG_DIR: '/profiles/work' }, { list })).toEqual(['mcp__work']);
  });
});
