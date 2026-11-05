import { z } from 'zod';
import { createAutomationInputSchema } from './automations.ts';

/**
 * Export / import transport formats (spec 2026-11-04-automations-and-config-export-import).
 *
 * Every envelope is `.strict()` and version-gated: a file written by a newer cezar, or carrying a
 * key this version never heard of, is refused whole rather than half-understood. A v2 adds keys
 * under a new version number; these v1 schemas never widen.
 */

export const AUTOMATIONS_FILE_FORMAT = 'cezar-automations';
export const AUTOMATIONS_FILE_VERSION = 1;

const versionGate = (format: string) =>
  z.literal(1, {
    error: (issue) =>
      typeof issue.input === 'number' && issue.input > 1
        ? `this file was written by a newer cezar (version ${issue.input}); update cezar to import it`
        : `not a valid ${format} file version`,
  });

/**
 * One automation as a file carries it: the editable subset `POST /automations` accepts, minus
 * `enabled`/`enable` — an import always lands paused. Ids, revisions, timestamps, a composer's
 * `deferredStart` and every runtime key are refused.
 */
export const portableAutomationSchema = createAutomationInputSchema.omit({ enable: true }).strict();
export type PortableAutomation = z.infer<typeof portableAutomationSchema>;

export const automationsFileSchema = z
  .object({
    format: z.literal(AUTOMATIONS_FILE_FORMAT, { error: 'this is not a cezar automations file' }),
    version: versionGate(AUTOMATIONS_FILE_FORMAT),
    exportedAt: z.string(),
    cezarVersion: z.string().optional(),
    automations: z.array(portableAutomationSchema).max(500),
  })
  .strict();
export type AutomationsFile = z.infer<typeof automationsFileSchema>;

/** `GET /automations/export` — `ids` is a comma-separated list; absent exports every automation. */
export const automationsExportQuerySchema = z.object({ ids: z.string().max(20_000).optional() });

export const automationImportActionSchema = z.enum(['create', 'skip', 'rename', 'replace']);
export type AutomationImportAction = z.infer<typeof automationImportActionSchema>;

/** The user's choice for one row, keyed by the row's index in the file. */
export const automationImportResolutionSchema = z
  .object({
    action: z.enum(['skip', 'rename', 'replace']),
    newName: z.string().trim().min(1).max(200).optional(),
    /** Explicit consent for a row whose task runs shell check steps — a badge alone is not consent. */
    acceptCommands: z.boolean().optional(),
    /** Clear a `task.agentProfile` this machine does not have, so the project default runs it. */
    useDefaultAccount: z.boolean().optional(),
  })
  .strict();
export type AutomationImportResolution = z.infer<typeof automationImportResolutionSchema>;

export const automationImportResolutionsSchema = z.record(z.string().regex(/^\d+$/), automationImportResolutionSchema);
export type AutomationImportResolutions = z.infer<typeof automationImportResolutionsSchema>;

export const automationImportPreviewInputSchema = z
  .object({ file: automationsFileSchema, resolutions: automationImportResolutionsSchema.optional() })
  .strict();
export type AutomationImportPreviewInput = z.input<typeof automationImportPreviewInputSchema>;

export const automationImportInputSchema = z
  .object({
    file: automationsFileSchema,
    resolutions: automationImportResolutionsSchema.optional(),
    planDigest: z.string().min(1).max(200),
  })
  .strict();
export type AutomationImportInput = z.input<typeof automationImportInputSchema>;

/** One planned row of an import preview. */
export const automationImportRowSchema = z.object({
  index: z.number(),
  name: z.string(),
  kind: z.enum(['github', 'schedule', 'tracker']),
  action: automationImportActionSchema,
  /** The existing automation a `replace` overwrites. */
  target: z.string().optional(),
  /** The name a `rename` lands under. */
  newName: z.string().optional(),
  /** The automation (or earlier file row) this row's name collides with. */
  collision: z.object({ id: z.string().optional(), name: z.string() }).optional(),
  /** Anything that blocks applying the row; a skipped row carries none. */
  issues: z.array(z.string()),
  /** Non-blocking notes (a one-time schedule already in the past). */
  warnings: z.array(z.string()),
  runsCommands: z.boolean(),
});
export type AutomationImportRow = z.infer<typeof automationImportRowSchema>;

export const automationImportPreviewSchema = z.object({
  rows: z.array(automationImportRowSchema),
  /** Staleness check only — apply recomputes the plan and refuses when this differs. */
  planDigest: z.string(),
});
export type AutomationImportPreview = z.infer<typeof automationImportPreviewSchema>;

export const automationImportResultSchema = z.object({
  created: z.array(z.string()),
  replaced: z.array(z.string()),
  skipped: z.number(),
});
export type AutomationImportResult = z.infer<typeof automationImportResultSchema>;
