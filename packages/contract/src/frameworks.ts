import { z } from 'zod';
import { runnerSchema } from './health.ts';
import { workflowGraphSchema } from './workflows.ts';

/**
 * Frameworks (spec 2026-11-15-framework-board): the framework file the server re-validates every
 * YAML with, and the `/frameworks` family's answers. A framework compiles to a v2 graph
 * (`src/frameworks/compile.ts`), so every id here is a graph node id prefix.
 */

/** Same shape as a graph node id (`workflows.ts` `nodeId`): stage ids become node id prefixes. */
const stageId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'stage ids are letters, digits, "-" and "_" (no dots)');

/** Mirrors the graph's `verdictName`: a verdict becomes an agent node's output port. */
const verdictName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'verdicts are letters, digits, "-" and "_"')
  .refine((v) => v !== 'failed' && v !== 'done', 'verdicts cannot be named "done" or "failed"');

const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'card field names are letters, digits and "_"');

export const frameworkGateSchema = z.discriminatedUnion('kind', [
  /** A `gate.human` node: Approve / Request changes → `onReject` (default: the previous stage). */
  z.object({ kind: z.literal('approve'), message: z.string().min(1).optional(), onReject: stageId.optional() }),
  /** Wait until the framework's `state.command` reports `approve` (or this stage, when null) done. */
  z.object({ kind: z.literal('framework'), approve: z.string().min(1).nullable() }),
]);
export type FrameworkGate = z.infer<typeof frameworkGateSchema>;

export const frameworkStageSchema = z.object({
  id: stageId,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  skill: z.string().min(1).optional(),
  /** A backend slash command, e.g. `/openspec:apply`. */
  command: z.string().regex(/^\/\S+/, 'a command starts with "/"').optional(),
  mode: z.enum(['autonomous', 'conversation']).optional(),
  session: z.union([z.literal('fresh'), z.object({ continue: stageId })]).optional(),
  /** Globs the stage must leave (D14); may contain `{{card.<field>}}`. */
  artifacts: z.array(z.string().min(1)).optional(),
  gate: frameworkGateSchema.optional(),
  model: z.string().min(1).optional(),
  runner: runnerSchema.optional(),
  wip: z.number().int().positive().optional(),
  checks: z.array(z.string().min(1)).optional(),
  /** Shell command run in the worktree before the stage starts; non-zero parks the card. */
  precheck: z.string().min(1).optional(),
  /** A reviewer in a fresh session, never the implementer's. */
  review: z.boolean().optional(),
  verdicts: z.array(verdictName).min(1).optional(),
  onVerdict: z.record(z.string(), stageId).optional(),
  /** Bound on every back edge out of this stage (verdicts, failing checks, request changes). */
  loopMax: z.number().int().positive().max(10).optional(),
  /** A boolean card field; the stage is not compiled when it is false. */
  skipUnless: fieldName.optional(),
});
export type FrameworkStage = z.infer<typeof frameworkStageSchema>;

export const frameworkCardFieldSchema = z.object({
  name: fieldName,
  label: z.string().min(1),
  type: z.enum(['string', 'boolean']).optional(),
  pattern: z.string().optional(),
  /** Derive the default from the card title (slugified). */
  from: z.literal('title').optional(),
  default: z.union([z.string(), z.boolean()]).optional(),
});
export type FrameworkCardField = z.infer<typeof frameworkCardFieldSchema>;

export const frameworkFileSchema = z
  .object({
    id: stageId,
    name: z.string().min(1),
    description: z.string().optional(),
    provisional: z.boolean().optional(),
    /** Paths that must ALL exist for the framework to be detected (D6). */
    detect: z.array(z.string().min(1)).optional(),
    /** Paths a card's branch must carry for the framework to run; absent = `detect`. Checked on
     *  the ref a card forks from at creation, and in its worktree at every stage entry. */
    requires: z.array(z.string().min(1)).optional(),
    state: z.object({ command: z.string().min(1), watch: z.string().min(1).optional() }).optional(),
    cardFields: z.array(frameworkCardFieldSchema).optional(),
    stages: z.array(frameworkStageSchema).min(1),
  })
  .superRefine((fw, ctx) => {
    const index = new Map<string, number>();
    fw.stages.forEach((s, i) => {
      if (index.has(s.id)) ctx.addIssue({ code: 'custom', path: ['stages', i, 'id'], message: `duplicate stage id "${s.id}"` });
      else index.set(s.id, i);
    });
    const fields = new Map((fw.cardFields ?? []).map((f) => [f.name, f]));
    if (fields.size !== (fw.cardFields ?? []).length) ctx.addIssue({ code: 'custom', path: ['cardFields'], message: 'card field names must be unique' });
    // `allowSelf`: a request-changes edge may send the work back to the stage that produced it.
    const back = (i: number, target: string, path: (string | number)[], what: string, allowSelf = false) => {
      const t = index.get(target);
      if (t === undefined) ctx.addIssue({ code: 'custom', path, message: `${what} names unknown stage "${target}"` });
      else if (t > i || (t === i && !allowSelf)) ctx.addIssue({ code: 'custom', path, message: `${what} must name an earlier stage (got "${target}")` });
    };
    fw.stages.forEach((s, i) => {
      const at = ['stages', i];
      if (s.skill && s.command) ctx.addIssue({ code: 'custom', path: at, message: `stage "${s.id}": skill and command are exclusive` });
      if (s.onVerdict) {
        if (!s.verdicts) ctx.addIssue({ code: 'custom', path: [...at, 'onVerdict'], message: `stage "${s.id}": onVerdict needs verdicts` });
        for (const [v, target] of Object.entries(s.onVerdict)) {
          if (s.verdicts && !s.verdicts.includes(v)) ctx.addIssue({ code: 'custom', path: [...at, 'onVerdict', v], message: `stage "${s.id}": "${v}" is not one of its verdicts` });
          back(i, target, [...at, 'onVerdict', v], `stage "${s.id}" onVerdict.${v}`);
        }
        if (s.verdicts && s.verdicts.every((v) => s.onVerdict?.[v])) {
          ctx.addIssue({ code: 'custom', path: [...at, 'onVerdict'], message: `stage "${s.id}": at least one verdict must move forward` });
        }
      }
      if (s.verdicts && new Set(s.verdicts).size !== s.verdicts.length) ctx.addIssue({ code: 'custom', path: [...at, 'verdicts'], message: `stage "${s.id}" repeats a verdict` });
      if (s.gate?.kind === 'approve' && s.gate.onReject) back(i, s.gate.onReject, [...at, 'gate', 'onReject'], `stage "${s.id}" gate.onReject`, true);
      if (s.session && s.session !== 'fresh') {
        back(i, s.session.continue, [...at, 'session'], `stage "${s.id}" session.continue`);
        if (s.review) ctx.addIssue({ code: 'custom', path: [...at, 'session'], message: `stage "${s.id}": a review stage always starts fresh` });
      }
      if (s.gate?.kind === 'framework' && !fw.state) {
        ctx.addIssue({ code: 'custom', path: [...at, 'gate'], message: `stage "${s.id}": a framework gate needs the framework's state.command` });
      }
      if (s.skipUnless && fields.get(s.skipUnless)?.type !== 'boolean') {
        ctx.addIssue({ code: 'custom', path: [...at, 'skipUnless'], message: `stage "${s.id}": skipUnless must name a boolean card field` });
      }
    });
  });
export type FrameworkFile = z.infer<typeof frameworkFileSchema>;

// ---- `/frameworks` family ----------------------------------------------------------------

export const frameworkSourceSchema = z.enum(['builtin', 'project']);
export type FrameworkSource = z.infer<typeof frameworkSourceSchema>;

/** Which framework new cards use, and why (D6). */
export const activeFrameworkSchema = z.object({
  id: z.string(),
  source: z.enum(['explicit', 'detected', 'fallback']),
  /** The detect path that matched, when `source` is `detected`. */
  detectedBy: z.string().optional(),
});
export type ActiveFramework = z.infer<typeof activeFrameworkSchema>;

/** One `GET /frameworks` row. A project file that does not parse is listed with `error`. */
/** What "Install into this repo" downloads and writes, for its confirm dialog. */
export const frameworkInstallInfoSchema = z.object({
  /** e.g. `open-mercato/sdd`, fetched from GitHub. */
  source: z.string(),
  /** Short commit sha the source is pinned to. */
  ref: z.string(),
  /** Repo-relative paths the installer writes (a trailing `/` is a directory). */
  writes: z.array(z.string()),
  /** The checked-out branch (null when HEAD is detached) — where a commit lands. */
  currentBranch: z.string().nullable(),
  /** The branch cards fork from; a commit is offered only when it is the checked-out one. */
  baseBranch: z.string().nullable(),
});
export type FrameworkInstallInfo = z.infer<typeof frameworkInstallInfoSchema>;

export const frameworkSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  provisional: z.boolean().optional(),
  source: frameworkSourceSchema,
  /** Project files only: repo-relative path of the YAML. */
  path: z.string().optional(),
  stages: z.array(z.object({ id: z.string(), name: z.string() })),
  /** How many stages have their skill/command in this repo (stages with neither count as found). */
  availability: z
    .object({
      found: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      /** `POST /frameworks/:id/install` can install it (it carries `install`). */
      installable: z.boolean(),
    })
    .optional(),
  install: frameworkInstallInfoSchema.optional(),
  /** Git repos only, for a framework that `requires` paths: whether every one is committed on
   *  `baseRef`, the ref new cards fork from. Absent = nothing to check (no requires, not git). */
  installedOnBase: z.boolean().optional(),
  baseRef: z.string().optional(),
  /** The required paths missing on `baseRef` (empty when `installedOnBase`). */
  missingOnBase: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type FrameworkSummary = z.infer<typeof frameworkSummarySchema>;

export const frameworksResponseSchema = z.object({
  frameworks: z.array(frameworkSummarySchema),
  active: activeFrameworkSchema,
});
export type FrameworksResponse = z.infer<typeof frameworksResponseSchema>;

/** Whether a stage's skill or command exists in this repo (Framework detail, mockup 6). */
export const stageAvailabilitySchema = z.object({
  stage: z.string(),
  kind: z.enum(['skill', 'command', 'none']),
  /** The skill name or the command (with its leading `/`). Absent for `none`. */
  name: z.string().optional(),
  present: z.boolean(),
});
export type StageAvailability = z.infer<typeof stageAvailabilitySchema>;

export const frameworkIdParamSchema = z.object({ id: stageId });
export type FrameworkIdParam = z.infer<typeof frameworkIdParamSchema>;

/** `GET /frameworks/:id` — `graph` is compiled for a sample card (default fields, no skips). */
export const frameworkDetailResponseSchema = z.object({
  framework: frameworkFileSchema,
  yaml: z.string(),
  stages: z.array(stageAvailabilitySchema),
  graph: workflowGraphSchema,
  source: frameworkSourceSchema,
});
export type FrameworkDetailResponse = z.infer<typeof frameworkDetailResponseSchema>;

/** `POST /frameworks/:id/duplicate` → `.ai/cezar/frameworks/<newId>.yaml`; 409 when it exists. */
export const duplicateFrameworkBodySchema = z.object({ newId: stageId });
export type DuplicateFrameworkBody = z.infer<typeof duplicateFrameworkBodySchema>;
export const duplicateFrameworkResponseSchema = z.object({ id: z.string(), path: z.string() });
export type DuplicateFrameworkResponse = z.infer<typeof duplicateFrameworkResponseSchema>;

/** `PUT /project/framework` — `null` removes the explicit choice (back to automatic, D6). */
export const putProjectFrameworkBodySchema = z.object({ framework: stageId.nullable() });
export type PutProjectFrameworkBody = z.infer<typeof putProjectFrameworkBodySchema>;
export const putProjectFrameworkResponseSchema = z.object({ active: activeFrameworkSchema });
export type PutProjectFrameworkResponse = z.infer<typeof putProjectFrameworkResponseSchema>;

/** `POST /frameworks/:id/install` — runs the framework's pinned installer in this repo (local only). */
export const installFrameworkBodySchema = z.object({ commit: z.boolean().optional() });
export type InstallFrameworkBody = z.infer<typeof installFrameworkBodySchema>;
export const installFrameworkResponseSchema = z.object({
  ok: z.literal(true),
  changedPaths: z.array(z.string()),
  committed: z.boolean(),
  /** Why it was left uncommitted, or where it was committed. */
  note: z.string().optional(),
  /** The installer's own stdout (its "Next:" hints). */
  output: z.string(),
});
export type InstallFrameworkResponse = z.infer<typeof installFrameworkResponseSchema>;
