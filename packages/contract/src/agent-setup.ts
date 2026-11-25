import { z } from 'zod';

import { runnerSchema } from './health.ts';
import { terminalSessionSchema } from './terminal.ts';

/**
 * Installing, updating and signing in to an agent from the cockpit (spec
 * 2026-10-26-first-run-onboarding, "Set up an agent here", and spec
 * 2026-11-25-agent-cli-install-and-update). A request names a provider and an action; the command
 * always comes from the server's own recipe table.
 */

/** Every agent: the ones cezar cannot install still get a command to copy and a docs link. */
export const agentSetupProviderSchema = runnerSchema;
export type AgentSetupProvider = z.infer<typeof agentSetupProviderSchema>;

export const agentSetupActionSchema = z.enum(['install', 'login', 'update']);
export type AgentSetupAction = z.infer<typeof agentSetupActionSchema>;

export const agentInstallMethodSchema = z.enum(['native', 'npm', 'brew', 'script']);
export type AgentInstallMethod = z.infer<typeof agentInstallMethodSchema>;

/** One command and whether cezar runs it here. A command that is not `runnable` is the line to copy. */
export const agentCommandPlanSchema = z.object({
  command: z.string().nullable(),
  runnable: z.boolean(),
  method: agentInstallMethodSchema.nullable(),
  /** Starts with `sudo`: the password goes in a terminal on the computer. */
  sudo: z.boolean(),
});
export type AgentCommandPlan = z.infer<typeof agentCommandPlanSchema>;

export const agentVersionStateSchema = z.enum(['current', 'update-available', 'update-required', 'unknown']);
export type AgentVersionState = z.infer<typeof agentVersionStateSchema>;

export const agentSetupEntrySchema = z.object({
  provider: agentSetupProviderSchema,
  /** The install cezar would run here; null when it would not (nothing here can install it, or the
   *  recipe is copy-only), and then `install.command` is the line to copy. */
  installCommand: z.string().nullable(),
  installHint: z.string(),
  loginCommand: z.string().nullable(),
  install: agentCommandPlanSchema,
  /** Null while not installed, or when no update is known for how it was installed. */
  update: agentCommandPlanSchema.nullable(),
  docsUrl: z.string(),
  /** Why cezar never runs this agent's installer, when it never does. */
  copyOnlyReason: z.string().nullable(),
  installed: z.boolean(),
  version: z.string().nullable(),
  /** How the installed copy got there, read from where its binary lives. */
  method: agentInstallMethodSchema.nullable(),
  /** The oldest version cezar is known to drive, including one an agent error stated. */
  minVersion: z.string().nullable(),
  /** The newest release, only when the request asked for it (`?latest=1`) and the lookup is on. */
  latestVersion: z.string().nullable(),
  versionState: agentVersionStateSchema,
  /** The vendor keeps it current by itself; null = not known. */
  autoUpdates: z.boolean().nullable(),
  /** Tasks running on this agent right now: an update waits for them unless told otherwise. */
  activeRuns: z.number().int().min(0),
});
export type AgentSetupEntry = z.infer<typeof agentSetupEntrySchema>;

export const agentSetupSessionSchema = terminalSessionSchema.extend({
  provider: agentSetupProviderSchema,
  action: agentSetupActionSchema,
  /** What this session runs, shown above its screen. */
  command: z.string(),
});
export type AgentSetupSession = z.infer<typeof agentSetupSessionSchema>;

/** `GET /api/v1/providers/setup`. Unavailable (hosted, terminal off, no PTY) is an answer, not an
 *  error: the page then falls back to commands to copy. */
export const agentSetupStateSchema = z.discriminatedUnion('available', [
  /** `agents` still answers, so the page can offer the commands to copy. */
  z.object({ available: z.literal(false), reason: z.string(), agents: z.array(agentSetupEntrySchema) }),
  z.object({
    available: z.literal(true),
    agents: z.array(agentSetupEntrySchema),
    /** False on a paired phone: no typing into the terminal, and only installs and updates that
     *  need no password start from there. */
    interactive: z.boolean(),
    /** The running or just-finished session, so a reload reattaches instead of starting another install. */
    session: agentSetupSessionSchema.nullable(),
  }),
]);
export type AgentSetupState = z.infer<typeof agentSetupStateSchema>;

/** `POST /api/v1/providers/setup/sessions`. */
export const agentSetupStartSchema = z.object({
  provider: agentSetupProviderSchema,
  action: agentSetupActionSchema,
  /** Update even while tasks run on this agent. */
  force: z.boolean().optional(),
  cols: z.number().int().min(1).max(500).optional(),
  rows: z.number().int().min(1).max(500).optional(),
});
export type AgentSetupStart = z.infer<typeof agentSetupStartSchema>;

export const agentSetupSessionParamsSchema = z.object({ sessionId: z.string() });

/** `GET /api/v1/providers/setup?latest=1` also looks up the newest release of each agent. */
export const agentSetupQuerySchema = z.object({ latest: z.enum(['0', '1']).optional() });
export type AgentSetupQuery = z.infer<typeof agentSetupQuerySchema>;
