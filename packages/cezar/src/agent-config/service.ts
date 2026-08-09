import { readFile } from 'node:fs/promises';
import { agentHomePaths, claudeStateFilePath } from '../paths.ts';
import { CONFIG_FILES, type ConfigFileDef } from './catalog.ts';
import { hashBytes, statConfigPath } from './files.ts';

/**
 * Assembles the `GET /api/agent-config` payload: every catalog file's current
 * on-disk state plus, locally, a read-only listing of the MCP servers Claude
 * keeps in its own state file (`~/.claude.json`). In hosted mode (`editable`
 * false) writes are refused server-side and the `~/.claude.json` listing is
 * withheld — it is host state a hosted client is not trusted to see.
 */

export interface ConfigFileListing {
  id: string;
  runners: ConfigFileDef['runners'];
  kind: ConfigFileDef['kind'];
  scope: ConfigFileDef['scope'];
  label: string;
  path: string;
  format: ConfigFileDef['format'];
  tracked: ConfigFileDef['tracked'];
  seeded: boolean;
  holdsMcp: boolean;
  precedence: string;
  hotReload?: string;
  docsUrl: string;
  exists: boolean;
  size: number;
  /** sha256 of the bytes, or null when absent. */
  version: string | null;
  /** False in hosted mode (whole feature) — the client renders read-only up front. */
  writable: boolean;
  readOnlyReason?: string;
}

export interface UserMcpListing {
  path: string;
  servers: string[];
  readable: boolean;
}

export interface AgentConfigListing {
  editable: boolean;
  files: ConfigFileListing[];
  /** null in hosted mode (host-state disclosure guard). */
  userMcp: UserMcpListing | null;
}

const HOSTED_REASON = 'agent config is edited from the machine that owns the checkout (this cockpit runs in hosted mode)';
/** ~/.claude.json can be large (per-project history); cap the read. */
const CLAUDE_JSON_CAP = 2 * 1024 * 1024;

async function versionOf(path: string, exists: boolean): Promise<string | null> {
  if (!exists) return null;
  try {
    return hashBytes(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Read the user-scope MCP server *names* from ~/.claude.json — never its contents, never for writing. */
export async function readUserMcpServers(env: NodeJS.ProcessEnv): Promise<UserMcpListing> {
  // Claude's own MCP state file. Sibling of `~/.claude/` by default, INSIDE the
  // dir once CLAUDE_CONFIG_DIR relocates it — `claudeStateFilePath` owns that rule.
  const path = claudeStateFilePath(agentHomePaths(env).claude, env);
  try {
    const { size } = await statConfigPath(path);
    if (size > CLAUDE_JSON_CAP) return { path, servers: [], readable: false };
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? Object.keys(parsed.mcpServers) : [];
    return { path, servers, readable: true };
  } catch (err) {
    // ENOENT → readable (no servers); anything else → not readable
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { path, servers: [], readable: true };
    return { path, servers: [], readable: false };
  }
}

export async function listAgentConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  editable: boolean,
): Promise<AgentConfigListing> {
  const home = agentHomePaths(env);
  const files = await Promise.all(
    CONFIG_FILES.map(async (def): Promise<ConfigFileListing> => {
      const path = def.resolve(repoRoot, home);
      const { exists, size } = await statConfigPath(path);
      return {
        id: def.id,
        runners: def.runners,
        kind: def.kind,
        scope: def.scope,
        label: def.label,
        path,
        format: def.format,
        tracked: def.tracked,
        seeded: Boolean(def.seeded),
        holdsMcp: Boolean(def.holdsMcp),
        precedence: def.precedence,
        hotReload: def.hotReload,
        docsUrl: def.docsUrl,
        exists,
        size,
        version: await versionOf(path, exists),
        writable: editable,
        readOnlyReason: editable ? undefined : HOSTED_REASON,
      };
    }),
  );
  return {
    editable,
    files,
    userMcp: editable ? await readUserMcpServers(env) : null,
  };
}
