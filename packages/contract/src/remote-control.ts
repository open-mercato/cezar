import { z } from 'zod';

/**
 * Claude Remote Control (spec 2026-08-26-remote-control): the cockpit-managed
 * `claude remote-control` server for a project, controllable from claude.ai/code or the
 * Claude mobile app.
 *
 * Node-free by construction (see README rule 1) — `zod` only.
 */

/** The one process lifecycle the server reports. `error` keeps the last failure visible
 *  until the next start; `starting` covers the window between spawn and the claude.ai
 *  link appearing in the CLI's output. */
export const remoteControlStateSchema = z.enum(['stopped', 'starting', 'running', 'error']);
export type RemoteControlState = z.infer<typeof remoteControlStateSchema>;

/**
 * `GET /remote-control`, and the answer of both mutations
 * (`POST /remote-control/start`, `POST /remote-control/stop`).
 *
 * `available` mirrors `capabilities().localHandoff` — hosted mode has no local claude CLI
 * to launch, so the section hides and the mutations 409 (`reason` says why). Every
 * optional key is spread conditionally on the server, never written as `key: undefined`.
 */
export const remoteControlStatusSchema = z.object({
  available: z.boolean(),
  /** Why `available` is false — human wording, shown verbatim. */
  reason: z.string().optional(),
  state: remoteControlStateSchema,
  /** The claude.ai environment link, once the CLI announced it (state `running`). */
  url: z.string().optional(),
  /** ISO timestamp of the successful start that produced `running`. */
  startedAt: z.string().optional(),
  /** The failure behind state `error` — the CLI's own words (trust refusal included). */
  error: z.string().optional(),
});
export type RemoteControlStatus = z.infer<typeof remoteControlStatusSchema>;
