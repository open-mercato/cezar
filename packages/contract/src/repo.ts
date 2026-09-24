import { z } from 'zod';
import { repoInfoSchema } from './health.ts';

/**
 * The repo / git family of `/api/v1` — the Repo view, the structured diff shapes the Changes and
 * Files tabs read, and the worktree-retention panel.
 *
 * `RepoInfo` is NOT redeclared here: health already owns it (`./health.ts`), and the Repo view
 * serves the very same record.
 */

/** One `git status --porcelain` row. */
export const statusEntrySchema = z.object({
  status: z.string(),
  path: z.string(),
});
export type StatusEntry = z.infer<typeof statusEntrySchema>;

/** One `git log` row; `when` is git's relative `%cr` ("3 hours ago"), not a timestamp. */
export const logEntrySchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  when: z.string(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/**
 * `GET /api/v1/repo` — the Repo view's one read.
 *
 * A union, and deliberately so: the handler answers a DIFFERENT object when the project root is
 * not a repository (`server.ts:3481`) than when it is (`server.ts:3494`), and the empty branch's
 * `[]` literals make its arrays `never[]` in the route type. Modelling this as the flat
 * `{ info: RepoInfo | null; status: StatusEntry[]; … }` the hand-written DTO used would be WIDER
 * than the route — the parity guard rejects it. Both members still parse the real wire bytes
 * (an empty array satisfies `z.array(z.never())`), so nothing is lost at runtime; it is the
 * compile-time shape that is oddly precise. See the report note on `server.ts:3481`.
 */
export const repoResponseSchema = z.union([
  z.object({
    info: z.null(),
    status: z.array(z.never()),
    log: z.array(z.never()),
    branches: z.array(z.never()),
    baseBranch: z.null(),
  }),
  z.object({
    info: repoInfoSchema,
    status: z.array(statusEntrySchema),
    log: z.array(logEntrySchema),
    branches: z.array(z.string()),
    baseBranch: z.string().nullable(),
  }),
]);
export type RepoResponse = z.infer<typeof repoResponseSchema>;

/** `POST /api/v1/repo/branch` — switch to an existing branch, or create one and switch. Every
 *  predictable git failure (invalid name, unknown `from`, dirty-tree conflict) is a 409. */
export const repoBranchResponseSchema = z.object({
  branch: z.string(),
  created: z.boolean(),
});
export type RepoBranchResponse = z.infer<typeof repoBranchResponseSchema>;

/** The aggregate line counts every structured-diff payload carries. Module-local: the runs family
 *  carries its own `DiffStat` of the same shape, and two `export`s of one name would collide when
 *  `contract/index.ts` re-exports both files. */
const diffStatSchema = z.object({
  adds: z.number(),
  dels: z.number(),
  files: z.number(),
});

/** One changed file of a structured diff (`/runs/:id/changes`, `/repo/changes`, the commit
 *  routes). Assignable to the diff facade's `DiffFileChange` by construction. */
export const changedFileSchema = z.object({
  path: z.string(),
  /** Rename/copy source — present only when `status` is renamed/copied. */
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied']),
  adds: z.number(),
  dels: z.number(),
  /** Binary per numstat — there is no text patch to render. */
  binary: z.boolean(),
  /** True when the path is one the raw-bytes route serves as an `<img>` (#365) — present only
   *  when true, so old clients that never read it stay correct. */
  image: z.boolean().optional(),
  /** This file's unified-diff section; possibly `… (patch truncated)`, possibly empty. */
  patch: z.string(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

/** `GET /api/v1/runs/:id/changes` and `GET /api/v1/repo/changes` — the structured diff.
 *  409 (+ reason) when the run's backing directory is unavailable or git itself refuses; never HTML. */
export const changesPayloadSchema = z.object({
  files: z.array(changedFileSchema),
  stat: diffStatSchema,
  /** Additive context for review tasks whose worktree HEAD no longer matches their own branch. */
  repointedHead: z.object({ headBranch: z.string(), taskBranch: z.string() }).optional(),
});
export type ChangesPayload = z.infer<typeof changesPayloadSchema>;

/** `GET /api/v1/repo/commit/:sha?structured=1` (and `/runs/:id/commit/:sha`) — one commit's
 *  metadata plus the same `{files, stat}` shape the /changes routes serve. A merge commit
 *  honestly answers zero files. The bare (unstructured) route keeps its legacy text shape. */
export const repoCommitPayloadSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  /** Relative time ("3 hours ago") — same `%cr` format as the /api/v1/repo log. */
  when: z.string(),
  files: z.array(changedFileSchema),
  stat: diffStatSchema,
});
export type RepoCommitPayload = z.infer<typeof repoCommitPayloadSchema>;

/** One row of a `GET /api/v1/runs/:id/files` directory listing. */
export const worktreeDirEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['dir', 'file']),
  size: z.number().optional(),
});
export type WorktreeDirEntry = z.infer<typeof worktreeDirEntrySchema>;

/**
 * `GET /api/v1/runs/:id/files?path=` — a directory listing or one file (size-capped, binary
 * flagged). `content` is absent exactly when `binary` or `tooLarge`.
 *
 * A discriminated union on `type`. Both handlers now build their literal with `as const`; without
 * it the property widened to `string` during Hono's route-type inference and the route lost the
 * discriminant, so a consumer narrowing on `entry.type === 'dir'` was left with `never`.
 */
export const worktreeEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dir'),
    path: z.string(),
    entries: z.array(worktreeDirEntrySchema),
  }),
  z.object({
    type: z.literal('file'),
    path: z.string(),
    size: z.number(),
    binary: z.boolean(),
    tooLarge: z.boolean(),
    content: z.string().optional(),
  }),
]);
export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;

/**
 * The lifecycle states a task can be in. Declared here (module-local, not exported) only because
 * `GET /api/v1/worktrees` echoes a run's `status` verbatim and the runs family's own contract
 * module does not exist yet — replace with that module's `runStatusSchema` when it lands.
 */
const worktreeRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]);

/** One materialized task worktree in the management panel (#483). `sizeBytes` is null when `du`
 *  is unavailable (Windows / missing). `reclaimable` = finished, has a directory, not yet
 *  reclaimed (retention's rule). */
export const worktreeInfoSchema = z.object({
  runId: z.string(),
  title: z.string(),
  status: worktreeRunStatusSchema,
  branch: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  finishedAt: z.string().nullable(),
  reclaimable: z.boolean(),
});
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>;

/** `GET /api/v1/worktrees` (#483): the worktrees on disk, their total size (null when any
 *  degraded), and the current keep-limit (0 = unlimited). */
export const worktreesResponseSchema = z.object({
  worktrees: z.array(worktreeInfoSchema),
  totalBytes: z.number().nullable(),
  keep: z.number(),
});
export type WorktreesResponse = z.infer<typeof worktreesResponseSchema>;

/** `POST /api/v1/worktrees/reclaim` (#483): the run ids whose directory was reclaimed. */
export const reclaimWorktreesResponseSchema = z.object({
  reclaimed: z.array(z.string()),
});
export type ReclaimWorktreesResponse = z.infer<typeof reclaimWorktreesResponseSchema>;
