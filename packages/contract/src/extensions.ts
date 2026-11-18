// Extension HTTP route shapes. The author surface (manifest, panels, forms, chat) is owned by the
// public SDK and re-exported from its workspace SOURCE, so no SDK build is needed to run the repo.
// The worker IPC protocol is internal to the service (packages/cezar/src/extensions/protocol.ts).
import { z } from 'zod'
import {
  extensionCapabilitySchema, extensionCommandLocationSchema, extensionFormSchema, extensionManifestSchema,
  extensionPanelLocationSchema, extensionPermissionSchema, extensionTaskProposalSchema,
} from '@open-mercato/cezar-extension-sdk/source'
export * from '@open-mercato/cezar-extension-sdk/source'

export const extensionStatusSchema = z.enum(['disabled', 'starting', 'running', 'failed'])
export type ExtensionStatus = z.infer<typeof extensionStatusSchema>
export const extensionRecordSchema = z.object({
  manifest: extensionManifestSchema,
  source: z.string().min(1).max(4096),
  installedAt: z.string(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
  /** Set only on a shipped chat adapter's record; an installed extension has none. */
  origin: z.literal('shipped').optional(),
  enabled: z.boolean(),
  status: extensionStatusSchema.optional(),
  error: z.string().max(500).optional(),
}).strict()
export type ExtensionRecord = z.infer<typeof extensionRecordSchema>

/** A run id as the store mints it (`^[A-Za-z0-9_-]{1,64}$`): what a task-located panel or command
 *  call may name (spec 2026-11-07-extension-placements). The server resolves it through the
 *  project's own store and answers 404 `run not found` for any other value. */
export const extensionRunIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** `GET /extensions/:extensionId/panels/:panelId?runId=` */
export const extensionPanelQuerySchema = z.object({ runId: extensionRunIdSchema.optional() }).strict()
export type ExtensionPanelQuery = z.infer<typeof extensionPanelQuerySchema>

/** `GET /extensions/placements?location=` — one cockpit surface; `palette` lists commands only,
 *  `sidebar` panels only, `settings` and `task` both. */
export const extensionPlacementLocationSchema = z.enum(['settings', 'sidebar', 'palette', 'task'])
export type ExtensionPlacementLocation = z.infer<typeof extensionPlacementLocationSchema>
export const extensionPlacementsQuerySchema = z.object({ location: extensionPlacementLocationSchema }).strict()
export type ExtensionPlacementsQuery = z.infer<typeof extensionPlacementsQuerySchema>
export const extensionPlacementPanelSchema = z.object({
  id: z.string().min(1).max(100), title: z.string().min(1).max(200), location: extensionPanelLocationSchema,
}).strict()
export type ExtensionPlacementPanel = z.infer<typeof extensionPlacementPanelSchema>
export const extensionPlacementCommandSchema = z.object({
  id: z.string().min(1).max(100), title: z.string().min(1).max(200), location: extensionCommandLocationSchema,
}).strict()
export type ExtensionPlacementCommand = z.infer<typeof extensionPlacementCommandSchema>
/** One ENABLED extension's contributions at the requested location, `location` already defaulted
 *  to `settings`. `status`/`error` are the worker's, so a surface can show a failed card. */
export const extensionPlacementSchema = z.object({
  extensionId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  name: z.string().min(1).max(200),
  status: extensionStatusSchema,
  error: z.string().max(500).optional(),
  panels: z.array(extensionPlacementPanelSchema).max(50),
  commands: z.array(extensionPlacementCommandSchema).max(50),
}).strict()
export type ExtensionPlacement = z.infer<typeof extensionPlacementSchema>
/** `available: false` (hosted, or `CEZ_EXTENSIONS=0`) always comes with an empty list — a read,
 *  so no 409: the cockpit hides the surfaces instead. */
export const extensionPlacementsResponseSchema = z.object({ available: z.boolean(), extensions: z.array(extensionPlacementSchema) }).strict()
export type ExtensionPlacementsResponse = z.infer<typeof extensionPlacementsResponseSchema>

export const extensionsResponseSchema = z.object({ extensions: z.array(extensionRecordSchema) }).strict()
export const installExtensionInputSchema = z.object({ source: z.string().trim().min(1).max(4096) }).strict()
export const extensionIdParamsSchema = z.object({ extensionId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/) })
export const extensionActionResponseSchema = z.object({ ok: z.boolean(), message: z.string().optional(), proposals: z.array(extensionTaskProposalSchema).max(10).optional() }).strict()
export const extensionPanelParamsSchema = extensionIdParamsSchema.extend({ panelId: z.string().min(1).max(100) })
export const extensionCommandParamsSchema = extensionIdParamsSchema.extend({ commandId: z.string().min(1).max(100) })
export const extensionPrepareInstallInputSchema = installExtensionInputSchema
/** What committing a preview changes for an already-installed id: every consent-relevant
 *  difference, and how many projects run it now (they keep it only when `keepsConsent`). */
export const extensionReplacementSchema = z.object({
  version: z.string(), sourceChanged: z.boolean(), keepsConsent: z.boolean(), enabledProjects: z.number().int().nonnegative(),
}).strict()
export const extensionPrepareInstallResponseSchema = z.object({
  preparedId: z.string().min(1).max(200), manifest: extensionManifestSchema,
  addedPermissions: z.array(extensionPermissionSchema), addedCapabilities: z.array(extensionCapabilitySchema),
  replaces: extensionReplacementSchema.optional(),
}).strict()
export const extensionCommitInstallInputSchema = z.object({ preparedId: z.string().min(1).max(200) }).strict()
export const extensionEnableInputSchema = z.object({ integrity: z.string().min(1) }).strict()
/** `runId` names the task a `task`-located command runs for; ignored by other locations
 *  but still resolved (404 when unknown). */
export const extensionInvokeInputSchema = z.object({ input: z.record(z.string(), z.unknown()).optional(), runId: extensionRunIdSchema.optional() }).strict()
export type ExtensionInvokeInput = z.infer<typeof extensionInvokeInputSchema>
/** Every extension route's refusal: 400 failed, 404 unknown, 409 extensions unavailable here. */
export const extensionErrorResponseSchema = z.object({ error: z.string() }).strict()
export const extensionMutationResponseSchema = z.object({ ok: z.literal(true) }).strict()
export const extensionFormsResponseSchema = z.object({ forms: z.array(extensionFormSchema) }).strict()
export const extensionUninstallQuerySchema = z.object({ removeData: z.enum(['true', 'false']).optional(), impactRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()

/** Passive software inventory. Availability never means a bot is connected. */
export const extensionProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('bundled'),hostVersion:z.string(),integrity:z.string()}).strict(),
  z.object({kind:z.enum(['folder','npm']),source:z.string()}).strict(),
])
export const extensionAvailabilitySchema = z.enum(['available','disabled','missing','failed','flag-disabled','hosted'])
export const extensionInventoryArtifactSchema = z.object({
  record: extensionRecordSchema,
  provenance: extensionProvenanceSchema,
  availability: extensionAvailabilitySchema,
  selectedVersion: z.string(),
  management: z.object({enable:z.boolean(),disable:z.boolean(),update:z.boolean(),uninstall:z.boolean()}).strict(),
  providers: z.array(z.object({id:z.string(),label:z.string()}).strict()),
}).strict()
/** An installed candidate does not replace the project's selected shipped implementation. */
export const extensionInventoryItemSchema = extensionInventoryArtifactSchema.extend({
  installedCandidate: extensionInventoryArtifactSchema.optional(),
}).strict()
export const extensionInventoryResponseSchema = z.object({extensions:z.array(extensionInventoryItemSchema)}).strict()
export type ExtensionInventoryItem = z.infer<typeof extensionInventoryItemSchema>
export const extensionUninstallImpactSchema = z.object({
  extensionId:z.string(), scope:z.literal('all-projects'), revision:z.string().regex(/^[a-f0-9]{64}$/),
  projects:z.array(z.object({
    projectId:z.string(),name:z.string(),enabled:z.boolean(),providers:z.array(z.string()),
    // What keeps this project's row (shown Missing) when the uninstall also deletes data.
    referencedBy:z.array(z.enum(['chat-selection','webhook-receiver'])).optional(),
  }).strict()),
  retainsConnectionData:z.literal(true),
}).strict()
export type ExtensionUninstallImpact = z.infer<typeof extensionUninstallImpactSchema>

export const extensionChatSelectionParamsSchema = z.object({provider:z.enum(['telegram'])})
export const extensionChatSelectionTargetSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('shipped')}).strict(),
  z.object({kind:z.literal('installed'),extensionId:extensionIdParamsSchema.shape.extensionId,localProviderId:z.string().min(1).max(100),integrity:z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/)}).strict(),
])
export const extensionChatSelectionInputSchema = z.object({target:extensionChatSelectionTargetSchema,enabled:z.boolean()}).strict()
export type ExtensionChatSelectionInput = z.infer<typeof extensionChatSelectionInputSchema>
export const extensionChatSelectionPreviewSchema = extensionChatSelectionInputSchema.extend({
  provider:extensionChatSelectionParamsSchema.shape.provider,
  revision:z.string().regex(/^[a-f0-9]{64}$/),
  selectionRevision:z.uuid().nullable(),
  current:extensionRecordSchema.nullable(),
  candidate:extensionRecordSchema,
  addedPermissions:z.array(extensionPermissionSchema),
  addedCapabilities:z.array(extensionCapabilitySchema),
}).strict()
export type ExtensionChatSelectionPreview = z.infer<typeof extensionChatSelectionPreviewSchema>
export const extensionChatSelectionCommitSchema = extensionChatSelectionInputSchema.extend({revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
