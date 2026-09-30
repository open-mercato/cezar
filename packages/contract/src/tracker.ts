import { z } from 'zod';

/** Jira Cloud and Linear are the two read-only tracker providers supported by this contract. */
export const trackerKindSchema = z.enum(['jira', 'linear']);
export type TrackerKind = z.infer<typeof trackerKindSchema>;

const httpsUrlSchema = z.url({ protocol: /^https$/ });
const nonemptyStringSchema = z.string().min(1);
const trackerCursorSchema = z.string().min(1).max(4096);

/** Stable vendor identity and the human-facing web origin that belongs to it. */
export const trackerSourceSchema = z
  .object({
    id: nonemptyStringSchema,
    webUrl: httpsUrlSchema,
  })
  .strict();
export type TrackerSource = z.infer<typeof trackerSourceSchema>;

/** A Jira project or Linear team offered by credential-scoped discovery. */
export const trackerCandidateSchema = z
  .object({
    id: nonemptyStringSchema,
    name: nonemptyStringSchema,
  })
  .strict();
export type TrackerCandidate = z.infer<typeof trackerCandidateSchema>;

/** The non-secret, server-resolved association persisted for one cezar project. */
export const trackerAssociationSchema = z
  .object({
    kind: trackerKindSchema,
    source: trackerSourceSchema,
    externalId: z.string(),
    externalName: z.string(),
    connectionId: z.uuid().optional(),
  })
  .strict();
export type TrackerAssociation = z.infer<typeof trackerAssociationSchema>;

/** Non-secret read identity; display-name changes do not move an issue to another source. */
export function trackerReadScope(association: TrackerAssociation): string {
  return JSON.stringify([association.kind, association.source.id, association.source.webUrl, association.externalId, association.connectionId ?? null]);
}

/** Client-authored selection. Names and URLs are resolved from the vendor and cannot be supplied. */
export const trackerAssociationInputSchema = z
  .object({
    kind: trackerKindSchema,
    externalId: nonemptyStringSchema,
    sourceId: nonemptyStringSchema,
    connectionId: z.uuid().optional(),
  })
  .strict();
export type TrackerAssociationInput = z.infer<typeof trackerAssociationInputSchema>;

/** A provider-neutral Jira issue or Linear issue. */
export const trackerItemSchema = z
  .object({
    kind: z.literal('issue'),
    id: z.string(),
    title: z.string(),
    author: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    labels: z.array(z.string()),
    body: z.string(),
    bodyTruncated: z.boolean(),
    unsupportedContent: z.boolean(),
    url: httpsUrlSchema,
    status: z.string(),
  })
  .strict();
export type TrackerItem = z.infer<typeof trackerItemSchema>;

export const trackerFailureCodeSchema = z.enum([
  'not_configured',
  'credentials_missing',
  'unauthorized',
  'rate_limited',
  'unavailable',
  'source_changed',
  'invalid_response',
]);
export type TrackerFailureCode = z.infer<typeof trackerFailureCodeSchema>;

/** Controlled vendor/configuration failure. These remain HTTP 200 on read routes. */
export const trackerFailureSchema = z
  .object({
    available: z.literal(false),
    code: trackerFailureCodeSchema,
    reason: z.string(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TrackerFailure = z.infer<typeof trackerFailureSchema>;

/** Driver-only cursor failure, mapped by the route to HTTP 400. */
export const trackerInvalidCursorSchema = z
  .object({
    available: z.literal(false),
    code: z.literal('invalid_cursor'),
    reason: z.string(),
  })
  .strict();
export type TrackerInvalidCursor = z.infer<typeof trackerInvalidCursorSchema>;

/** Driver-only missing item/candidate result, mapped by the route to HTTP 404 where applicable. */
export const trackerNotFoundSchema = z
  .object({
    available: z.literal(false),
    code: z.literal('not_found'),
    reason: z.string(),
  })
  .strict();
export type TrackerNotFound = z.infer<typeof trackerNotFoundSchema>;

function enforcePagination(
  page: { truncated: boolean; nextCursor?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (page.truncated && page.nextCursor === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['nextCursor'],
      message: 'nextCursor is required when truncated is true',
    });
  }
  if (!page.truncated && page.nextCursor !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['nextCursor'],
      message: 'nextCursor must be omitted when truncated is false',
    });
  }
}

export const trackerCandidatesSuccessSchema = z
  .object({
    available: z.literal(true),
    source: trackerSourceSchema,
    candidates: z.array(trackerCandidateSchema),
    truncated: z.boolean(),
    nextCursor: trackerCursorSchema.optional(),
  })
  .strict()
  .superRefine(enforcePagination);
export type TrackerCandidatesSuccess = z.infer<typeof trackerCandidatesSuccessSchema>;

export const trackerItemsSuccessSchema = z
  .object({
    available: z.literal(true),
    items: z.array(trackerItemSchema),
    truncated: z.boolean(),
    nextCursor: trackerCursorSchema.optional(),
  })
  .strict()
  .superRefine(enforcePagination);
export type TrackerItemsSuccess = z.infer<typeof trackerItemsSuccessSchema>;

export const trackerItemSuccessSchema = z
  .object({
    available: z.literal(true),
    item: trackerItemSchema,
  })
  .strict();
export type TrackerItemSuccess = z.infer<typeof trackerItemSuccessSchema>;

export const trackerAssociationSuccessSchema = z
  .object({
    available: z.literal(true),
    association: trackerAssociationSchema,
  })
  .strict();
export type TrackerAssociationSuccess = z.infer<typeof trackerAssociationSuccessSchema>;

const trackerCollectionFailureSchema = z.discriminatedUnion('code', [
  trackerFailureSchema,
  trackerInvalidCursorSchema,
]);
const trackerLookupFailureSchema = z.discriminatedUnion('code', [
  trackerFailureSchema,
  trackerNotFoundSchema,
]);

/** Driver result: HTTP routes remove `invalid_cursor` before constructing a 200 response. */
export const trackerCandidatesResultSchema = z.discriminatedUnion('available', [
  trackerCandidatesSuccessSchema,
  trackerCollectionFailureSchema,
]);
export type TrackerCandidatesResult = z.infer<typeof trackerCandidatesResultSchema>;

/** Driver result: HTTP routes remove `invalid_cursor` before constructing a 200 response. */
export const trackerItemsResultSchema = z.discriminatedUnion('available', [
  trackerItemsSuccessSchema,
  trackerCollectionFailureSchema,
]);
export type TrackerItemsResult = z.infer<typeof trackerItemsResultSchema>;

/** Driver result: the detail route maps only `not_found` to HTTP 404. */
export const trackerItemResultSchema = z.discriminatedUnion('available', [
  trackerItemSuccessSchema,
  trackerLookupFailureSchema,
]);
export type TrackerItemResult = z.infer<typeof trackerItemResultSchema>;

/** Driver result used while validating a selected candidate before persistence. */
export const trackerAssociationResultSchema = z.discriminatedUnion('available', [
  trackerAssociationSuccessSchema,
  trackerLookupFailureSchema,
]);
export type TrackerAssociationResult = z.infer<typeof trackerAssociationResultSchema>;

/** HTTP 200 response for candidate discovery; invalid cursors are HTTP 400 instead. */
export const trackerCandidatesResponseSchema = z.discriminatedUnion('available', [
  trackerCandidatesSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerCandidatesResponse = z.infer<typeof trackerCandidatesResponseSchema>;

/** HTTP 200 response for issue list/search; invalid cursors are HTTP 400 instead. */
export const trackerItemsResponseSchema = z.discriminatedUnion('available', [
  trackerItemsSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerItemsResponse = z.infer<typeof trackerItemsResponseSchema>;

/** HTTP 200 detail response; a missing item is represented by the route's HTTP 404 envelope. */
export const trackerItemResponseSchema = z.discriminatedUnion('available', [
  trackerItemSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerItemResponse = z.infer<typeof trackerItemResponseSchema>;

export const trackerAssociationResponseSchema = z
  .object({ association: trackerAssociationSchema.nullable() })
  .strict();
export type TrackerAssociationResponse = z.infer<typeof trackerAssociationResponseSchema>;

export const trackerClearedResponseSchema = z.object({ cleared: z.literal(true) }).strict();
export type TrackerClearedResponse = z.infer<typeof trackerClearedResponseSchema>;

export const trackerErrorResponseSchema = z.object({ error: z.string() }).strict();
export type TrackerErrorResponse = z.infer<typeof trackerErrorResponseSchema>;

const trackerQueryTextSchema = z.string().trim().min(1).max(256);
const trackerQueryCursorSchema = trackerCursorSchema.optional();
const trackerQueryLimitSchema = z.coerce.number<string>().int().min(1).max(100).default(50);
const trackerRefreshSchema = z.enum(['0', '1']).optional();
const trackerStateSchema = z.enum(['active', 'all']);
const trackerLabelsArraySchema = z.array(nonemptyStringSchema).max(20);
const trackerLabelsQuerySchema = z.string().transform((raw, context): string[] => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    context.addIssue({ code: 'custom', message: 'labels must be a JSON array of strings' });
    return z.NEVER;
  }
  const parsed = trackerLabelsArraySchema.safeParse(decoded);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'labels must be a JSON array of 0 to 20 nonempty strings' });
    return z.NEVER;
  }
  return parsed.data;
});

export const trackerCandidatesQuerySchema = z.object({
  kind: trackerKindSchema,
  q: trackerQueryTextSchema.optional(),
  cursor: trackerQueryCursorSchema,
  limit: trackerQueryLimitSchema,
});
export type TrackerCandidatesQueryInput = z.input<typeof trackerCandidatesQuerySchema>;
export type TrackerCandidatesQuery = z.output<typeof trackerCandidatesQuerySchema>;

const trackerExpectedScopeSchema = z.string().max(4096).optional();

export const trackerItemQuerySchema = z.object({ expectedScope: trackerExpectedScopeSchema });
export type TrackerItemQuery = z.infer<typeof trackerItemQuerySchema>;

export const trackerListQuerySchema = z.object({
  expectedScope: trackerExpectedScopeSchema,
  cursor: trackerQueryCursorSchema,
  limit: trackerQueryLimitSchema,
  refresh: trackerRefreshSchema,
  state: trackerStateSchema.default('active'),
  labels: trackerLabelsQuerySchema.optional(),
});
export type TrackerListQueryInput = z.input<typeof trackerListQuerySchema>;
export type TrackerListQuery = z.output<typeof trackerListQuerySchema>;

export const trackerSearchQuerySchema = z.object({
  expectedScope: trackerExpectedScopeSchema,
  cursor: trackerQueryCursorSchema,
  limit: trackerQueryLimitSchema,
  refresh: trackerRefreshSchema,
  state: trackerStateSchema.default('all'),
  labels: trackerLabelsQuerySchema.optional(),
  q: trackerQueryTextSchema,
});
export type TrackerSearchQueryInput = z.input<typeof trackerSearchQuerySchema>;
export type TrackerSearchQuery = z.output<typeof trackerSearchQuerySchema>;

const reservedTrackerItemIds = ['association', 'candidates', 'search', 'connection'];

/** One bounded vendor identifier path segment; static tracker routes are never detail IDs. */
export const trackerItemParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/]+$/, 'id must be one path segment')
    .refine((id) => !reservedTrackerItemIds.includes(id), 'id is reserved by a static route'),
});
export type TrackerItemParams = z.infer<typeof trackerItemParamsSchema>;


// Association changes are workspace events; consumers refetch authoritative local state.
export const trackerChangedEventSchema = z.object({ project: z.string().min(1) }).strict();
export type TrackerChangedEvent = z.infer<typeof trackerChangedEventSchema>;
export const trackerAssociationSavedResponseSchema = z.object({ association: trackerAssociationSchema }).strict();
export type TrackerAssociationSavedResponse = z.infer<typeof trackerAssociationSavedResponseSchema>;

/** Write-only project credentials. Never return this shape from an HTTP handler. */
const trackerSecretSchema = z.string().trim().min(1).max(8192);
export const trackerCredentialsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('jira'), origin: z.string().max(512).regex(/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\/?$/i, 'Use an HTTPS Jira Cloud site origin'), email: z.email().max(320), token: trackerSecretSchema }).strict(),
  z.object({ kind: z.literal('linear'), key: trackerSecretSchema }).strict(),
]);
export type TrackerCredentials = z.infer<typeof trackerCredentialsSchema>;
export const trackerConnectionSchema = z.object({ id: z.uuid(), kind: trackerKindSchema }).strict();
export type TrackerConnection = z.infer<typeof trackerConnectionSchema>;
export const trackerConnectionResponseSchema = z.object({
  connection: trackerConnectionSchema.nullable(), demo: z.boolean(), error: z.string().optional(),
}).strict();
export type TrackerConnectionResponse = z.infer<typeof trackerConnectionResponseSchema>;

/** Visible-list observation: bounded first page, explicit project association. */
export const trackerWatchInputSchema = z.object({
  association: trackerAssociationSchema,
  query: z.string().trim().max(256),
  state: trackerStateSchema,
  labels: z.array(z.string().trim().min(1).max(256)).max(20),
}).strict();
export type TrackerWatchInput = z.infer<typeof trackerWatchInputSchema>;
export const trackerWatchParamsSchema = z.object({ watchId: z.uuid() });
export const trackerWatchQuerySchema = z.object({ after: z.coerce.number<string>().int().nonnegative().optional() });
export const trackerWatchHandleSchema = z.object({ id: z.uuid(), topic: z.string() }).strict();
export type TrackerWatchHandle = z.infer<typeof trackerWatchHandleSchema>;
export const trackerWatchSignalSchema = z.object({ version: z.number().int().nonnegative() }).strict();
export const trackerWatchSnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  checking: z.boolean(),
  checkedAt: z.iso.datetime().nullable(),
  result: trackerItemsResponseSchema.nullable(),
}).strict();
export type TrackerWatchSnapshot = z.infer<typeof trackerWatchSnapshotSchema>;
