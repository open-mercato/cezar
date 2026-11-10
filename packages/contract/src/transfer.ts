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

/**
 * The user's choice for one row, keyed by the row's index in the file. `create` is only valid for
 * a row whose name is free; it exists so a non-colliding row can carry `acceptCommands`.
 */
export const automationImportResolutionSchema = z
  .object({
    action: automationImportActionSchema,
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

// ---- configuration bundle (Phase 2) ------------------------------------------------------------

export const CONFIG_BUNDLE_FORMAT = 'cezar-config-bundle';

/**
 * An open config value, re-validated by its owning schema on import. `any` rather than `unknown`
 * (hono serializes `unknown` to its own JSON type, so the parity check could never be exact) or
 * `z.json()` (recursive — too deep for hono's route-type inference).
 */
const jsonValue = z.any();

/**
 * The portable workspace keys. An allowlist on purpose: a key added to the workspace config
 * later is not exported until someone decides it is portable (`config-bundle.test.ts` makes
 * that decision mandatory). Values are re-validated by the owning schema on import.
 */
export const bundleWorkspaceSchema = z
  .object({
    resources: jsonValue.optional(),
    composerDefaults: jsonValue.optional(),
    agentDefaults: jsonValue.optional(),
    disabledProviders: jsonValue.optional(),
    systemPrompt: jsonValue.optional(),
    modelsLocked: jsonValue.optional(),
    orgSkillsRepos: jsonValue.optional(),
    skillsAutoUpdate: jsonValue.optional(),
  })
  .strict();
export type BundleWorkspace = z.infer<typeof bundleWorkspaceSchema>;

/** The portable `.ai/cezar/config.json` keys (same allowlist rule). */
export const bundleProjectConfigSchema = z
  .object({
    skillsRepos: jsonValue.optional(),
    worktreeRetention: jsonValue.optional(),
    defaultRunner: jsonValue.optional(),
    plannerModel: jsonValue.optional(),
    namerModel: jsonValue.optional(),
    namerModels: jsonValue.optional(),
    liveTitleUpdates: jsonValue.optional(),
    reviewGate: jsonValue.optional(),
    baseBranch: jsonValue.optional(),
    systemPrompt: jsonValue.optional(),
    branchNaming: jsonValue.optional(),
    defaultModels: jsonValue.optional(),
    defaultModelsAuto: jsonValue.optional(),
    modelsLocked: jsonValue.optional(),
    profile: jsonValue.optional(),
    taskWorkspace: jsonValue.optional(),
    requiredChecks: jsonValue.optional(),
    defaultSkill: jsonValue.optional(),
    askSkill: jsonValue.optional(),
  })
  .strict();
export type BundleProjectConfig = z.infer<typeof bundleProjectConfigSchema>;

export const bundlePromptTemplateSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(20_000),
    skills: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();
export type BundlePromptTemplate = z.infer<typeof bundlePromptTemplateSchema>;

export const bundleProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** `host/owner/repo` — normalized, never carrying credentials. Absent for a repo with no forge remote. */
    remote: z.string().max(500).optional(),
    config: bundleProjectConfigSchema.optional(),
    promptTemplates: z.array(bundlePromptTemplateSchema).max(50).optional(),
    automations: automationsFileSchema.optional(),
    /** Shown on import, never written: secret NAMES and the tracker provider to reconnect. */
    reminders: z
      .object({ secretNames: z.array(z.string().max(200)).max(500), tracker: z.string().max(40).optional() })
      .strict(),
  })
  .strict();
export type BundleProject = z.infer<typeof bundleProjectSchema>;

export const configBundleSchema = z
  .object({
    format: z.literal(CONFIG_BUNDLE_FORMAT, { error: 'this is not a cezar configuration bundle' }),
    version: versionGate(CONFIG_BUNDLE_FORMAT),
    exportedAt: z.string(),
    cezarVersion: z.string().optional(),
    workspace: bundleWorkspaceSchema.optional(),
    projects: z.array(bundleProjectSchema).max(200),
    reminders: z.object({ workspaceSecretNames: z.array(z.string().max(200)).max(500) }).strict(),
  })
  .strict();
export type ConfigBundle = z.infer<typeof configBundleSchema>;

/** `GET /workspace/config-bundle` — `projects` is a comma-separated id list; absent = every present project. */
export const configBundleExportQuerySchema = z.object({ projects: z.string().max(20_000).optional() });

/**
 * Section ids: `workspace`, `project:<i>:config`, `project:<i>:promptTemplates`,
 * `project:<i>:automations` — `<i>` is the project's index in the bundle.
 */
export const bundleSectionIdSchema = z.string().regex(/^(workspace|project:\d+:(config|promptTemplates|automations))$/);

export const bundleSectionResolutionSchema = z
  .object({
    /** Per conflicting key: keep the target's value (default) or take the imported one. */
    keys: z.record(z.string().max(200), z.enum(['keep', 'take'])).optional(),
    automations: automationImportResolutionsSchema.optional(),
  })
  .strict();
export type BundleSectionResolution = z.infer<typeof bundleSectionResolutionSchema>;

export const configBundlePreviewInputSchema = z
  .object({
    bundle: configBundleSchema,
    /** Sections to apply; absent = every applicable section that runs no commands. */
    selection: z.array(bundleSectionIdSchema).max(1000).optional(),
    /** Bundle project index → registered project id (`null` skips it). Overrides remote matching. */
    mapping: z.record(z.string().regex(/^\d+$/), z.string().max(200).nullable()).optional(),
    resolutions: z.record(bundleSectionIdSchema, bundleSectionResolutionSchema).optional(),
  })
  .strict();
export type ConfigBundlePreviewInput = z.input<typeof configBundlePreviewInputSchema>;

export const configBundleImportInputSchema = configBundlePreviewInputSchema.extend({
  planDigest: z.string().min(1).max(200),
});
export type ConfigBundleImportInput = z.input<typeof configBundleImportInputSchema>;

export const bundleChangeSchema = z.object({
  key: z.string(),
  /** Absent when the target has no value for the key. */
  from: jsonValue.optional(),
  to: jsonValue,
  /** `take` writes `to`; `keep` leaves `from`. A key the target lacks is always taken. */
  action: z.enum(['keep', 'take']),
  conflict: z.boolean(),
});
export type BundleChange = z.infer<typeof bundleChangeSchema>;

export const bundleSectionPlanSchema = z.object({
  id: z.string(),
  kind: z.enum(['workspace', 'config', 'promptTemplates', 'automations']),
  /** Bundle project index for project sections. */
  projectIndex: z.number().optional(),
  /** The registered project this section lands in; absent while unmatched. */
  targetProjectId: z.string().optional(),
  selected: z.boolean(),
  changes: z.array(bundleChangeSchema),
  automations: z.array(automationImportRowSchema).optional(),
  runsCommands: z.boolean(),
  /** Anything that blocks applying the section when selected. */
  issues: z.array(z.string()),
});
export type BundleSectionPlan = z.infer<typeof bundleSectionPlanSchema>;

export const configBundlePreviewSchema = z.object({
  sections: z.array(bundleSectionPlanSchema),
  projects: z.array(
    z.object({
      index: z.number(),
      name: z.string(),
      remote: z.string().optional(),
      targetProjectId: z.string().optional(),
      /** How the target was chosen: by the remote, by the user's mapping, or not at all. */
      match: z.enum(['remote', 'mapped', 'unmatched', 'skipped']),
      reminders: z.object({ secretNames: z.array(z.string()), tracker: z.string().optional() }),
    }),
  ),
  reminders: z.object({ workspaceSecretNames: z.array(z.string()) }),
  /** False on a hosted cockpit: import is a local-machine capability. */
  importAllowed: z.boolean(),
  planDigest: z.string(),
});
export type ConfigBundlePreview = z.infer<typeof configBundlePreviewSchema>;

export const configBundleImportResultSchema = z.object({ applied: z.array(z.string()) });
export type ConfigBundleImportResult = z.infer<typeof configBundleImportResultSchema>;
