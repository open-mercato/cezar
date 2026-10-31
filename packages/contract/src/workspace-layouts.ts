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
export const workspaceViewSchema = z.enum(['session', 'changes', 'commits', 'files', 'browser', 'graph', 'terminal']);
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

/** The bounds, exported so the cockpit enforces the SAME ones where state grows: the whole
 *  document is validated per PUT, so one over-limit value fails every later save. */
export const MAX_WORKSPACE_COLUMNS = 3;
export const MAX_WORKSPACE_BROWSER_TABS = 12;
export const MAX_WORKSPACE_TAB_URL_LENGTH = 2048;
export const MAX_WORKSPACE_LAYOUT_NAME_LENGTH = 80;

/** A Browser column's own tabs (§7). Only successfully loaded addresses are stored, so these are
 *  plain strings; an empty string IS a blank tab. */
export const workspaceBrowserSchema = z.object({
  tabs: z.array(z.string().max(MAX_WORKSPACE_TAB_URL_LENGTH)).max(MAX_WORKSPACE_BROWSER_TABS),
  active: z.number().int().min(0).max(MAX_WORKSPACE_BROWSER_TABS - 1),
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
  name: z.string().min(1).max(MAX_WORKSPACE_LAYOUT_NAME_LENGTH),
  columns: z.array(workspaceColumnSchema).max(MAX_WORKSPACE_COLUMNS),
});
export type WorkspaceLayoutState = z.infer<typeof workspaceLayoutSchema>;

/** A backstop on cards per task. Far above any real strip (which folds past six into a menu),
 *  low enough that a loop cannot grow the file without bound. */
export const MAX_WORKSPACE_LAYOUTS = 50;

export const workspaceLayoutsSchema = z.object({
  layouts: z.array(workspaceLayoutSchema).max(MAX_WORKSPACE_LAYOUTS),
  /** The active card's name. May name a layout that is gone — the cockpit recovers rather than
   *  failing, so this is not cross-validated here. */
  active: z.string().max(MAX_WORKSPACE_LAYOUT_NAME_LENGTH),
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

/**
 * A layout the user SAVED by name — workspace-wide, so it is offered in every task of every
 * project (`savedLayouts` in `~/.cezar/ui-state.json`). Only the arrangement travels: which views,
 * how wide. A column's own state (a Preview's tabs) belongs to the task it was opened in.
 */
export const MAX_SAVED_WORKSPACE_LAYOUTS = 50;
export const savedWorkspaceLayoutSchema = z.object({
  name: z.string().trim().min(1).max(MAX_WORKSPACE_LAYOUT_NAME_LENGTH),
  columns: z
    .array(z.object({ view: workspaceViewSchema, width: z.number().finite().min(0).max(100) }))
    .min(1)
    .max(MAX_WORKSPACE_COLUMNS),
});
export type SavedWorkspaceLayout = z.infer<typeof savedWorkspaceLayoutSchema>;
