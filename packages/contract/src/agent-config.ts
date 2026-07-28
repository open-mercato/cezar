import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * The agent-config surface (spec #404): the settings / memory / MCP files the installed agent
 * CLIs read, listed and edited through `GET/PUT /agent-config[/:id]`.
 */

export const agentConfigFormatSchema = z.enum(['json', 'jsonc', 'toml', 'markdown']);
export type AgentConfigFormat = z.infer<typeof agentConfigFormatSchema>;

export const agentConfigScopeSchema = z.enum(['user', 'project', 'local']);
export type AgentConfigScope = z.infer<typeof agentConfigScopeSchema>;

/** `settings` = behavior knobs; `memory` = instruction/markdown; `mcp` = a dedicated MCP file. */
export const agentConfigKindSchema = z.enum(['settings', 'memory', 'mcp']);
export type AgentConfigKind = z.infer<typeof agentConfigKindSchema>;

/** Git status BY CONVENTION — it drives the honest label; it is not read from git. */
export const agentConfigTrackedSchema = z.enum(['tracked', 'gitignored', 'outside-repo']);
export type AgentConfigTracked = z.infer<typeof agentConfigTrackedSchema>;

/** One catalog file plus its current on-disk state. */
export const agentConfigFileSchema = z.object({
  /** Stable, opaque, URL-safe — the ONLY thing a client may name (traversal-proof). */
  id: z.string(),
  /** Every runner that reads this file: `<repo>/AGENTS.md` is one file, two readers. */
  runners: z.array(runnerSchema),
  kind: agentConfigKindSchema,
  scope: agentConfigScopeSchema,
  label: z.string(),
  path: z.string(),
  format: agentConfigFormatSchema,
  tracked: agentConfigTrackedSchema,
  seeded: z.boolean(),
  holdsMcp: z.boolean(),
  /** VERBATIM from the vendor docs. Never computed, never generic. */
  precedence: z.string(),
  /** Documented mid-run reload behaviour, or absent when the vendor is silent. */
  hotReload: z.string().optional(),
  docsUrl: z.string(),
  exists: z.boolean(),
  size: z.number(),
  /** sha256 of the bytes, or null when absent. */
  version: z.string().nullable(),
  /** False in hosted mode (whole feature) — the client renders read-only up front. */
  writable: z.boolean(),
  readOnlyReason: z.string().optional(),
});
export type AgentConfigFile = z.infer<typeof agentConfigFileSchema>;

/** Read-only listing of the MCP servers Claude keeps in `~/.claude.json`. */
export const userMcpListingSchema = z.object({
  path: z.string(),
  servers: z.array(z.string()),
  readable: z.boolean(),
});
export type UserMcpListing = z.infer<typeof userMcpListingSchema>;

/** `GET /agent-config` — the whole panel in one read. */
export const agentConfigListingSchema = z.object({
  editable: z.boolean(),
  files: z.array(agentConfigFileSchema),
  /** null in hosted mode (host-state disclosure guard). */
  userMcp: userMcpListingSchema.nullable(),
});
export type AgentConfigListing = z.infer<typeof agentConfigListingSchema>;

/** `GET /agent-config/:id` and the `PUT` echo — one file's bytes plus its stale-write token. */
export const agentConfigFileContentSchema = z.object({
  id: z.string(),
  path: z.string(),
  exists: z.boolean(),
  content: z.string(),
  /** sha256 of the bytes, or null when the file does not exist yet. */
  version: z.string().nullable(),
});
export type AgentConfigFileContent = z.infer<typeof agentConfigFileContentSchema>;

/**
 * `PUT /agent-config/:id` body. `version` is the token from the read that produced `content` —
 * `null` means "I expect no file to exist yet" (the create path); a mismatch is a 409.
 */
export const setAgentConfigInputSchema = z.object({
  content: z.string().max(2_000_000),
  version: z.string().nullable(),
});
export type SetAgentConfigInput = z.infer<typeof setAgentConfigInputSchema>;
