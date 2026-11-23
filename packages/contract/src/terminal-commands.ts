import { z } from 'zod';

import { startAppScopeSchema } from './start-app.ts';

/**
 * A run command a user defines for a project (#1555): a name and a command line, offered in the
 * task terminal's picker beside the commands discovered from `package.json` and the Makefile.
 * Commands always run in the task's worktree, through the same shell as any typed command.
 */
export const terminalCommandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(500),
});
export type TerminalCommand = z.infer<typeof terminalCommandSchema>;

export const TERMINAL_COMMANDS_MAX = 30;
export const terminalCommandListSchema = z.array(terminalCommandSchema).max(TERMINAL_COMMANDS_MAX);

/** `GET /api/v1/terminal-commands` and the answer to its `PUT`. Same two scopes as the start recipe. */
export const terminalCommandsStateSchema = z.object({
  project: terminalCommandListSchema,
  personal: terminalCommandListSchema,
  /** False where this project has no entry in the user's registry to hold personal commands. */
  personalAvailable: z.boolean(),
});
export type TerminalCommandsState = z.infer<typeof terminalCommandsStateSchema>;

/** `PUT /api/v1/terminal-commands` — replaces one scope's list; `[]` removes it. */
export const terminalCommandsSetSchema = z.object({
  scope: startAppScopeSchema,
  commands: terminalCommandListSchema,
});
export type TerminalCommandsSet = z.infer<typeof terminalCommandsSetSchema>;

/** A defined command as the picker receives it, with the scope it was defined in. */
export const configuredCommandSchema = terminalCommandSchema.extend({ scope: startAppScopeSchema });
export type ConfiguredCommandEntry = z.infer<typeof configuredCommandSchema>;
