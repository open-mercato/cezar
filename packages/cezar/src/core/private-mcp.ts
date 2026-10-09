import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunnerId } from './agent-runner.ts';

/**
 * Private, per-project MCP servers (spec `.ai/specs/2026-10-07-private-project-mcp.md`).
 *
 * One file, `<repo>/.ai/cezar/mcp.local.json`, in the same shape as Claude's `.mcp.json`
 * (`{ "mcpServers": { "<name>": { … } } }`). It lives in cezar's git-ignored data dir — never in
 * a run's worktree — so it cannot be committed by the user or by an agent, and a committed
 * `.mcp.json` next to it is irrelevant. Each runner injects the servers at launch through the
 * agent's own documented channel; nothing is written into the worktree:
 *
 *  - `claude`   — `--mcp-config <0600 temp file>` (additive to the repo's MCP config);
 *  - `codex`    — `thread/start|resume` `config` overrides, one `mcp_servers.<name>` key each;
 *  - `opencode` — `OPENCODE_CONFIG_CONTENT` (loaded after the project config, so it wins);
 *  - `junie`, `copilot` — ACP `session/new|load` `mcpServers`.
 *
 * `cursor` and `pi` have no launch-time MCP channel; a run on them gets a note instead.
 *
 * Pure apart from `loadPrivateMcp`, which never throws: an absent file is "no servers", a broken
 * one is "no servers" plus a problem string the run surfaces as a note.
 */

export const PRIVATE_MCP_FILE = 'mcp.local.json';

/** `<repo>/.ai/cezar/mcp.local.json` */
export function privateMcpPath(repoRoot: string): string {
  return join(repoRoot, '.ai', 'cezar', PRIVATE_MCP_FILE);
}

export type PrivateMcpTransport = 'stdio' | 'http' | 'sse';

export interface PrivateMcpServer {
  name: string;
  transport: PrivateMcpTransport;
  /** stdio only. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** http/sse only. */
  url?: string;
  headers: Record<string, string>;
}

/** The runners that can take private MCP servers at launch. */
export const PRIVATE_MCP_RUNNERS: readonly RunnerId[] = ['claude', 'codex', 'opencode', 'junie', 'copilot'];

export function supportsPrivateMcp(runner: string): boolean {
  return (PRIVATE_MCP_RUNNERS as readonly string[]).includes(runner);
}

/** The strictest name rule among the agents (Codex): letters, digits, `_` and `-`. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const stringRecord = z.record(z.string(), z.string());

const serverSchema = z
  .object({
    type: z.enum(['stdio', 'http', 'sse']).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: stringRecord.optional(),
    url: z.url({ protocol: /^https?$/ }).optional(),
    headers: stringRecord.optional(),
  })
  .passthrough();

const fileSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() }).passthrough();

export interface PrivateMcpLoad {
  servers: PrivateMcpServer[];
  /** One line per server or file that could not be used — surfaced as a run note. */
  problems: string[];
}

/** Parse the file's text. Bad entries are skipped one by one; one bad server never drops the rest. */
export function parsePrivateMcp(text: string): PrivateMcpLoad {
  const problems: string[] = [];
  if (text.trim() === '') return { servers: [], problems };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { servers: [], problems: [`${PRIVATE_MCP_FILE} is not valid JSON: ${(err as Error).message}`] };
  }
  const file = fileSchema.safeParse(raw);
  if (!file.success) {
    return { servers: [], problems: [`${PRIVATE_MCP_FILE} must be an object with an "mcpServers" object`] };
  }
  const servers: PrivateMcpServer[] = [];
  for (const [name, entry] of Object.entries(file.data.mcpServers ?? {})) {
    if (!SERVER_NAME_RE.test(name)) {
      problems.push(`MCP server "${name}" skipped: names may only use letters, digits, "_" and "-"`);
      continue;
    }
    const parsed = serverSchema.safeParse(entry);
    if (!parsed.success) {
      problems.push(`MCP server "${name}" skipped: ${parsed.error.issues[0]?.message ?? 'invalid entry'}`);
      continue;
    }
    const s = parsed.data;
    const transport: PrivateMcpTransport = s.type ?? (s.command ? 'stdio' : 'http');
    if (transport === 'stdio' && !s.command) {
      problems.push(`MCP server "${name}" skipped: a stdio server needs "command"`);
      continue;
    }
    if (transport !== 'stdio' && !s.url) {
      problems.push(`MCP server "${name}" skipped: an ${transport} server needs "url"`);
      continue;
    }
    servers.push({
      name,
      transport,
      ...(transport === 'stdio' ? { command: s.command } : { url: s.url }),
      args: transport === 'stdio' ? (s.args ?? []) : [],
      env: transport === 'stdio' ? (s.env ?? {}) : {},
      headers: transport === 'stdio' ? {} : (s.headers ?? {}),
    });
  }
  return { servers, problems };
}

/** Read and parse the project's private MCP file. Never throws. */
export async function loadPrivateMcp(repoRoot: string): Promise<PrivateMcpLoad> {
  let text: string;
  try {
    text = await readFile(privateMcpPath(repoRoot), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { servers: [], problems: [] };
    return { servers: [], problems: [`${PRIVATE_MCP_FILE} could not be read: ${(err as Error).message}`] };
  }
  return parsePrivateMcp(text);
}

// ---- per-agent translations ------------------------------------------------

/** Claude `--mcp-config` file contents (the `.mcp.json` shape, normalized). */
export function toClaudeMcpConfig(servers: readonly PrivateMcpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] =
      s.transport === 'stdio'
        ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
        : { type: s.transport, url: s.url, headers: s.headers };
  }
  return { mcpServers };
}

/**
 * Claude permission rules that let a headless (`dontAsk`) run call the private servers' tools.
 * `mcp__<server>` matches every tool of that server. The user added the server for this project
 * on purpose, so its tools are allowed like the default built-ins are.
 */
export function claudeMcpAllowRules(servers: readonly PrivateMcpServer[]): string[] {
  return servers.map((s) => `mcp__${s.name}`);
}

/**
 * Codex `thread/start` / `thread/resume` `config` overrides. One dotted key per server so the
 * user's own `[mcp_servers]` table is extended, not replaced. Codex speaks stdio and streamable
 * HTTP only — an `sse` server is returned in `skipped`.
 */
export function toCodexConfigOverrides(servers: readonly PrivateMcpServer[]): {
  config: Record<string, unknown>;
  skipped: string[];
} {
  const config: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const s of servers) {
    if (s.transport === 'sse') {
      skipped.push(s.name);
      continue;
    }
    config[`mcp_servers.${s.name}`] =
      s.transport === 'stdio'
        ? { command: s.command, args: s.args, ...(Object.keys(s.env).length ? { env: s.env } : {}) }
        : { url: s.url, ...(Object.keys(s.headers).length ? { http_headers: s.headers } : {}) };
  }
  return { config, skipped };
}

/** OpenCode `mcp` entries (`local` = stdio, `remote` = http/sse). */
export function toOpencodeMcp(servers: readonly PrivateMcpServer[]): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const s of servers) {
    mcp[s.name] =
      s.transport === 'stdio'
        ? {
            type: 'local',
            command: [s.command, ...s.args],
            ...(Object.keys(s.env).length ? { environment: s.env } : {}),
            enabled: true,
          }
        : { type: 'remote', url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}), enabled: true };
  }
  return mcp;
}

/**
 * The `OPENCODE_CONFIG_CONTENT` value for a run: the private servers merged into any inline
 * config the host already passes, so an existing value is extended rather than clobbered.
 */
export function opencodeConfigContent(servers: readonly PrivateMcpServer[], existing?: string): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // an unparseable host value cannot be merged into; the private servers still apply
    }
  }
  const baseMcp = base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp) ? base.mcp : {};
  return JSON.stringify({ ...base, mcp: { ...baseMcp, ...toOpencodeMcp(servers) } });
}

/** What an ACP agent advertised in `initialize` → `agentCapabilities.mcpCapabilities`. */
export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/** Read `agentCapabilities.mcpCapabilities` out of an ACP `initialize` result. */
export function acpMcpCapabilities(initializeResult: unknown): AcpMcpCapabilities {
  const caps = (initializeResult as { agentCapabilities?: { mcpCapabilities?: unknown } } | null)?.agentCapabilities
    ?.mcpCapabilities;
  if (!caps || typeof caps !== 'object') return {};
  const c = caps as Record<string, unknown>;
  return { http: c.http === true, sse: c.sse === true };
}

/**
 * ACP `mcpServers` for `session/new` / `session/load`. stdio is mandatory for every ACP agent;
 * http and sse only when the agent advertised them — otherwise the server lands in `skipped`.
 */
export function toAcpMcpServers(
  servers: readonly PrivateMcpServer[],
  caps: AcpMcpCapabilities,
): { mcpServers: unknown[]; skipped: string[] } {
  const pairs = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value }));
  const mcpServers: unknown[] = [];
  const skipped: string[] = [];
  for (const s of servers) {
    if (s.transport === 'stdio') {
      mcpServers.push({ name: s.name, command: s.command, args: s.args, env: pairs(s.env) });
    } else if (caps[s.transport]) {
      mcpServers.push({ type: s.transport, name: s.name, url: s.url, headers: pairs(s.headers) });
    } else {
      skipped.push(s.name);
    }
  }
  return { mcpServers, skipped };
}

/** The note a runner emits when some private servers could not be attached. */
export function skippedServersNote(runner: string, skipped: readonly string[], why: string): string {
  return `private MCP: ${runner} cannot attach ${skipped.join(', ')} — ${why}`;
}
