import { execFile } from 'node:child_process';
import { resolveClaudeBin } from './claude-bin.ts';

/**
 * The user's MCP servers, as `--allowedTools` grants for a headless Claude.
 *
 * Claude runs in `dontAsk` mode, where a tool missing from `--allowedTools` is refused without a
 * prompt — so every MCP tool the user had connected (BigQuery, Gmail, Notion…) was refused in every
 * cezar task. A wildcard does not help: `mcp__*` matches nothing (verified against Claude Code
 * 2.1.282), while `mcp__<server>` grants that server's every tool. So the servers have to be NAMED,
 * which means knowing them:
 *
 *  - `claude mcp list` names every server Claude would load for a directory and account — the
 *    claude.ai connectors included, which live in no file cezar could read. Run in the background,
 *    cached, bounded; a slow or broken one costs a run its MCP grants, never its start.
 *  - every session's `system/init` lists its exact tool names, so a server first seen in a run (a
 *    repo's own `.mcp.json`) is granted from the next session on, with no name guessed.
 *
 * Owner-approved exception to "exposure-widening features are opt-in" (AGENTS.md § Zero config):
 * on by default, `CEZ_MCP_TOOLS=0` turns it off. Only steps on the DEFAULT tool list get it — a
 * workflow step that lists its tools keeps exactly that list.
 */

const LIST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10 * 60_000;
/** How long a run waits for a first discovery before starting without it. */
const FIRST_WAIT_MS = 6_000;

export function mcpToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_MCP_TOOLS !== '0';
}

/**
 * The `--allowedTools` entry for a server, spelled the way Claude prefixes its tools: every
 * character outside `[A-Za-z0-9_-]` becomes `_` (`claude.ai Google Cloud BigQuery` →
 * `mcp__claude_ai_Google_Cloud_BigQuery`, whose tools are `mcp__claude_ai_Google_Cloud_BigQuery__…`).
 */
export function mcpServerGrant(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Server names from `claude mcp list`: one `<name>: <url or command> - <status>` line each. */
export function parseMcpList(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(.+?): \S.* - \S/.exec(line.trim());
    if (match?.[1]) names.push(match[1].trim());
  }
  return names;
}

/** The server grant a session's own tool names prove exists (`mcp__srv__tool` → `mcp__srv`). */
export function grantsFromTools(tools: readonly string[]): string[] {
  const grants = new Set<string>();
  for (const tool of tools) {
    const match = /^(mcp__[A-Za-z0-9_-]+?)__[^_]/.exec(tool);
    if (match?.[1]) grants.add(match[1]);
  }
  return [...grants];
}

const learned = new Set<string>();

/** Record the MCP servers a live session reported, so the next session is granted them. */
export function learnMcpGrants(tools: readonly string[]): void {
  for (const grant of grantsFromTools(tools)) learned.add(grant);
}

interface Discovery {
  grants: string[];
  at: number;
  pending?: Promise<string[]>;
}
const discoveries = new Map<string, Discovery>();

export type McpLister = (cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;

const listWithClaude: McpLister = (cwd, env) =>
  new Promise((resolve, reject) => {
    execFile(
      // Not `resolveClaudeExecutable`: the runner imports THIS module (it reports
      // what sessions saw), so importing it back would be a cycle. Its only other
      // answer is the dry-run mock, which the guard below never asks. The binary
      // lookup itself is shared, so a launchd cockpit — whose PATH has no
      // `~/.local/bin` — finds the same claude the runner does.
      resolveClaudeBin(),
      ['mcp', 'list'],
      { cwd, env: { ...process.env, ...env }, timeout: LIST_TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (error, stdout) => (error && !stdout ? reject(error) : resolve(String(stdout))),
    );
  });

/**
 * Every MCP grant cezar knows for a Claude session in `cwd` under `env` (an account's
 * `CLAUDE_CONFIG_DIR` has servers of its own). Never throws; waits at most `waitMs` for a first
 * discovery and otherwise answers what it has while the discovery finishes behind it.
 */
export async function claudeMcpGrants(
  cwd: string,
  env: Record<string, string> = {},
  opts: { list?: McpLister; waitMs?: number; now?: () => number } = {},
): Promise<string[]> {
  if (!mcpToolsEnabled() || process.env.CEZ_DRY_RUN === '1') return [];
  const now = opts.now ?? Date.now;
  const key = `${cwd}\0${env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? ''}`;
  let entry = discoveries.get(key);
  if (!entry || (now() - entry.at > CACHE_TTL_MS && !entry.pending)) {
    const previous = entry?.grants ?? [];
    const pending = (opts.list ?? listWithClaude)(cwd, env)
      .then((stdout) => parseMcpList(stdout).map(mcpServerGrant))
      .catch(() => previous);
    entry = { grants: previous, at: entry?.at ?? 0, pending };
    discoveries.set(key, entry);
    void pending.then((grants) => {
      discoveries.set(key, { grants, at: now() });
    });
  }
  const current = entry;
  let grants = current.grants;
  if (current.pending && current.at === 0) {
    // Nothing known for this directory yet: worth a short wait, since without it the first task
    // after a restart has no MCP at all. Bounded — a hung `claude mcp list` must not hold a run.
    let timer: NodeJS.Timeout | undefined;
    grants = await Promise.race([
      current.pending,
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve(current.grants), opts.waitMs ?? FIRST_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  return [...new Set([...grants, ...learned])].sort();
}

/** Tests only: forget discoveries and learned grants. */
export function resetClaudeMcpGrantsForTest(): void {
  discoveries.clear();
  learned.clear();
}
