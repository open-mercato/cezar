import { z } from 'zod';

/**
 * A task's saved workspace layouts (spec `.ai/specs/2026-10-07-task-workspace.md` §5.2, §5.3).
 *
 * The wire shape of what the cockpit builds in the view area, persisted by the cezar that owns
 * the task — §5.3: "Persist named layouts per task on the Cezar host that owns the task."
 *
 * Every axis is bounded, because this body is written straight to a file on the host: three
 * columns is the spec's own cap (§5.2), and the rest are sized so a hand-written request cannot
 * turn the store into a dumping ground.
 */

/** The surfaces a column can show. `terminal` is deliberately absent — it is the bottom drawer,
 *  not a column (§5.1). Kept in step with the cockpit's own `ViewId`. */
export const workspaceViewSchema = z.enum(['session', 'changes', 'commits', 'files', 'browser', 'graph']);
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

/** A Browser column's own tabs (§7). Only successfully loaded addresses are stored, so these are
 *  plain strings; an empty string IS a blank tab. */
export const workspaceBrowserSchema = z.object({
  tabs: z.array(z.string().max(2048)).max(12),
  active: z.number().int().min(0).max(11),
});
export type WorkspaceBrowserState = z.infer<typeof workspaceBrowserSchema>;

export const workspaceColumnSchema = z.object({
  view: workspaceViewSchema,
  /** Percent of the row. The cockpit normalises these on read, so a stored set that does not sum
   *  to 100 is recoverable rather than rejected. */
  width: z.number().finite().min(0).max(100),
  browser: workspaceBrowserSchema.optional(),
});
export type WorkspaceColumnState = z.infer<typeof workspaceColumnSchema>;

/** A layout holds ZERO to three columns — zero because §10 says "A saved layout may
 *  intentionally have no columns", which is the shape closing the last column leaves behind. */
export const workspaceLayoutSchema = z.object({
  name: z.string().min(1).max(80),
  columns: z.array(workspaceColumnSchema).max(3),
});
export type WorkspaceLayoutState = z.infer<typeof workspaceLayoutSchema>;

/** A backstop on cards per task. Far above any real strip (which folds past six into a menu),
 *  low enough that a loop cannot grow the file without bound. */
export const MAX_WORKSPACE_LAYOUTS = 50;

export const workspaceLayoutsSchema = z.object({
  layouts: z.array(workspaceLayoutSchema).max(MAX_WORKSPACE_LAYOUTS),
  /** The active card's name. May name a layout that is gone — the cockpit recovers rather than
   *  failing, so this is not cross-validated here. */
  active: z.string().max(80),
});
export type WorkspaceLayouts = z.infer<typeof workspaceLayoutsSchema>;

/**
 * `GET /runs/:id/layouts`.
 *
 * `layouts: null` means this task has never been opened, which is NOT the same as an empty list:
 * an empty list is a workspace the user emptied on purpose and §5.3 keeps it empty for the visit,
 * while "never opened" is what the cockpit answers with a fresh `Czat` card.
 */
export const workspaceLayoutsResponseSchema = z.object({
  layouts: workspaceLayoutsSchema.nullable(),
});
export type WorkspaceLayoutsResponse = z.infer<typeof workspaceLayoutsResponseSchema>;
