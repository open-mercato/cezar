import { z } from 'zod';

export const IssueAnalysisSchema = z.object({
  // Duplicates action
  duplicateOf: z.number().nullable().default(null),
  duplicateConfidence: z.number().min(0).max(1).nullable().default(null),
  duplicateReason: z.string().nullable().default(null),
  duplicatesAnalyzedAt: z.string().nullable().default(null),

  // Priority action
  priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
  priorityReason: z.string().nullable().default(null),
  prioritySignals: z.array(z.string()).nullable().default(null),
  priorityAnalyzedAt: z.string().nullable().default(null),

  // Auto-label action
  suggestedLabels: z.array(z.string()).nullable().default(null),
  labelsReason: z.string().nullable().default(null),
  labelsAnalyzedAt: z.string().nullable().default(null),
  labelsAppliedAt: z.string().nullable().default(null),

  // Missing info action
  missingInfoFields: z.array(z.string()).nullable().default(null),
  missingInfoComment: z.string().nullable().default(null),
  missingInfoAnalyzedAt: z.string().nullable().default(null),
  missingInfoPostedAt: z.string().nullable().default(null),

  // Recurring question action
  isRecurringQuestion: z.boolean().nullable().default(null),
  similarClosedIssues: z.array(z.number()).nullable().default(null),
  suggestedResponse: z.string().nullable().default(null),
  recurringAnalyzedAt: z.string().nullable().default(null),

  // Good first issue action
  isGoodFirstIssue: z.boolean().nullable().default(null),
  goodFirstIssueReason: z.string().nullable().default(null),
  goodFirstIssueHint: z.string().nullable().default(null),
  goodFirstIssueAnalyzedAt: z.string().nullable().default(null),

  // Security triage action
  securityFlag: z.boolean().nullable().default(null),
  securityConfidence: z.number().min(0).max(1).nullable().default(null),
  securityCategory: z.string().nullable().default(null),
  securitySeverity: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
  securityAnalyzedAt: z.string().nullable().default(null),

  // Stale issue action
  staleAction: z
    .enum(['close-resolved', 'close-wontfix', 'label-stale', 'keep-open'])
    .nullable()
    .default(null),
  staleReason: z.string().nullable().default(null),
  staleDraftComment: z.string().nullable().default(null),
  staleAnalyzedAt: z.string().nullable().default(null),

  // Quality check action
  qualityFlag: z.enum(['spam', 'vague', 'test', 'wrong-language', 'ok']).nullable().default(null),
  qualityReason: z.string().nullable().default(null),
  qualityAnalyzedAt: z.string().nullable().default(null),

  // Contributor welcome action
  welcomeCommentPostedAt: z.string().nullable().default(null),

  // Claim detector action
  claimDetectedBy: z.string().nullable().default(null),
  claimComment: z.string().nullable().default(null),
  claimDetectedAt: z.string().nullable().default(null),

  // Categorize action
  featureCategory: z.enum(['framework', 'domain', 'integration']).nullable().default(null),
  featureCategoryReason: z.string().nullable().default(null),
  featureCategoryAnalyzedAt: z.string().nullable().default(null),
  featureCategoryAppliedAt: z.string().nullable().default(null),

  // Done detector action
  doneDetected: z.boolean().nullable().default(null),
  doneConfidence: z.number().min(0).max(1).nullable().default(null),
  doneReason: z.string().nullable().default(null),
  doneDraftComment: z.string().nullable().default(null),
  doneMergedPRs: z
    .array(
      z.object({
        prNumber: z.number(),
        prTitle: z.string(),
      }),
    )
    .nullable()
    .default(null),
  doneAnalyzedAt: z.string().nullable().default(null),

  // Bug detector action
  issueType: z.enum(['bug', 'feature', 'question', 'other']).nullable().default(null),
  bugConfidence: z.number().min(0).max(1).nullable().default(null),
  bugReason: z.string().nullable().default(null),
  bugAnalyzedAt: z.string().nullable().default(null),

  // Autofix action
  autofixStatus: z
    .enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'pr-opened'])
    .nullable()
    .default(null),
  autofixAttempts: z.number().default(0),
  autofixLastRunAt: z.string().nullable().default(null),
  autofixBranch: z.string().nullable().default(null),
  autofixPrUrl: z.string().nullable().default(null),
  autofixPrNumber: z.number().nullable().default(null),
  autofixRootCause: z.string().nullable().default(null),
  autofixReviewVerdict: z.enum(['pass', 'fail']).nullable().default(null),
  autofixReviewNotes: z.string().nullable().default(null),
  autofixWorktreePath: z.string().nullable().default(null),
  autofixTokensUsed: z.number().default(0),
  autofixLastError: z.string().nullable().default(null),
});

export type IssueAnalysis = z.infer<typeof IssueAnalysisSchema>;

export const IssueDigestSchema = z.object({
  summary: z.string(),
  category: z.enum(['bug', 'feature', 'docs', 'chore', 'question', 'other']),
  affectedArea: z.string(),
  keywords: z.array(z.string()),
  digestedAt: z.string(),
});

export type IssueDigest = z.infer<typeof IssueDigestSchema>;

export const StoredCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export type StoredComment = z.infer<typeof StoredCommentSchema>;

export const StoredIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.string()),
  assignees: z.array(z.string()).default([]),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  htmlUrl: z.string(),
  contentHash: z.string(),
  commentCount: z.number().default(0),
  reactions: z.number().default(0),
  comments: z.array(StoredCommentSchema).default([]),
  commentsFetchedAt: z.string().nullable().default(null),
  digest: IssueDigestSchema.nullable().default(null),
  analysis: IssueAnalysisSchema.default({}),
});

export type StoredIssue = z.infer<typeof StoredIssueSchema>;

export const StoreMetaSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  lastSyncedAt: z.string().nullable().default(null),
  /** Set once a *complete* (all-states, including closed) sync has succeeded.
   *  Until then, sync does a full fetch rather than an incremental `since`
   *  fetch — this backfills closed issues for stores first synced by an older
   *  open-only sync, and bootstraps freshly-connected workspaces. */
  fullSyncedAt: z.string().nullable().default(null),
  totalFetched: z.number().default(0),
  version: z.literal(1).default(1),
  orgMembers: z.array(z.string()).default([]),
  orgMembersFetchedAt: z.string().nullable().default(null),
});

export type StoreMeta = z.infer<typeof StoreMetaSchema>;

export const StoreSchema = z.object({
  meta: StoreMetaSchema,
  issues: z.array(StoredIssueSchema),
});

export type Store = z.infer<typeof StoreSchema>;
