import { z } from 'zod';

/**
 * The workspace terminal (spec `.ai/specs/2026-10-07-task-workspace.md` §6, Milestone 2).
 *
 * One interactive shell per session, its cwd the task's own worktree. Output is read with a
 * CURSOR rather than streamed in the response: the same read serves the WebSocket path (wake on
 * the topic, then fetch what is new) and the hosted path (poll), so there is one output format
 * and one replay rule instead of two.
 */

/** A live (or just-exited) shell. */
export const terminalSessionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** The worktree the shell was started in — shown so a user can see WHICH tree they are typing into. */
  cwd: z.string(),
  shell: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  startedAt: z.string(),
  /** Null while the shell is alive; the exit status once it is gone. */
  exitCode: z.number().int().nullable(),
  /** The tab's name: the running (or last-run) command, else `Terminal N` (spec §6). */
  label: z.string(),
  /** The shell has a live child — something would be lost by closing this tab. */
  /** `null` = this host cannot read its process table (no `ps`), so busy-ness is unknown. The
   *  cockpit treats anything but `false` as "something may be running". */
  busy: z.boolean().nullable(),
  /** The WebSocket topic that wakes on new output. Local cockpits subscribe; hosted ones poll,
   *  because a browser WebSocket cannot carry reverse-proxy credentials. */
  topic: z.string(),
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

/**
 * What a task's terminal can do here, and what it already has open.
 *
 * `available` is the honest answer to BOTH gates at once: the policy gate (`capabilities.terminal`
 * — is a shell allowed on this cockpit at all) and the platform gate (did the optional PTY
 * binding load). When it is false, `reason` is a sentence to show the user, never a code.
 */
export const terminalStateSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  sessions: z.array(terminalSessionSchema),
});
export type TerminalState = z.infer<typeof terminalStateSchema>;

/** Opening a shell. Dimensions are the emulator's current size; the server clamps them. */
export const terminalCreateSchema = z.object({
  cols: z.number().int().min(1).max(500).optional(),
  rows: z.number().int().min(1).max(500).optional(),
});
export type TerminalCreateInput = z.infer<typeof terminalCreateSchema>;

/**
 * Keystrokes. Capped so one request cannot hand the shell an unbounded paste — 64 KB is far more
 * than a paste a human makes and far less than a body worth buffering.
 */
export const terminalInputSchema = z.object({
  data: z.string().max(65_536),
});
export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const terminalResizeSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500),
});
export type TerminalResize = z.infer<typeof terminalResizeSchema>;

/** Output since `cursor`. Omit it to replay the whole retained scrollback, which is what a tab
 *  being reattached after a reload wants. */
export const terminalOutputQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
});
export type TerminalOutputQuery = z.infer<typeof terminalOutputQuerySchema>;

export const terminalOutputSchema = z.object({
  data: z.string(),
  /** Pass back on the next read. */
  cursor: z.number().int(),
  /** The requested cursor was older than the retained scrollback, so output was missed. The
   *  emulator says so rather than splicing a gap into the screen silently. */
  truncated: z.boolean(),
  exitCode: z.number().int().nullable(),
});
export type TerminalOutput = z.infer<typeof terminalOutputSchema>;

/**
 * An address one of this task's terminals printed (spec §7).
 *
 * Collected, never opened: the spec is explicit that a detected address opens only when the user
 * clicks `Otwórz w Przeglądarce`. `running` is the answer to a TCP connect and nothing more —
 * cezar does not send a request to a server a task started.
 */
export const detectedUrlSchema = z.object({
  url: z.string(),
  lastSeenAt: z.string(),
  /** Null until probed. Distinct from `false`, which means "probed, nothing listening". */
  running: z.boolean().nullable(),
});
export type DetectedUrlEntry = z.infer<typeof detectedUrlSchema>;

export const detectedUrlsSchema = z.object({ urls: z.array(detectedUrlSchema) });
export type DetectedUrlsResponse = z.infer<typeof detectedUrlsSchema>;

/** A command the task's own project defines (spec §6). Discovery only — nothing runs until the
 *  user picks one, and then it runs in a new terminal tab. */
export const discoveredCommandSchema = z.object({
  command: z.string(),
  /** The file it came from, so `dev` from a Makefile is never confused with `dev` from npm. */
  source: z.string(),
  detail: z.string().optional(),
});
export type DiscoveredCommandEntry = z.infer<typeof discoveredCommandSchema>;

export const discoveredCommandsSchema = z.object({ commands: z.array(discoveredCommandSchema) });
export type DiscoveredCommandsResponse = z.infer<typeof discoveredCommandsSchema>;

export const terminalSessionParamsSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
});
export type TerminalSessionParams = z.infer<typeof terminalSessionParamsSchema>;
