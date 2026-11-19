/**
 * Review model v4 — the contract between the `change-impact` agent and the impact renderer
 * (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md`, Q7 and § Public API delta).
 *
 * v4 = the `pr-impact` v3 model (analysis-contract.md) plus `meta.subject_kind`, required ids on
 * trade-offs, fit rows, questions and conditions (every element of the report is addressable for
 * Ask and correct, R4), and `api_changes` (R3). This schema checks SHAPE only; every
 * cross-reference rule lives in `validate.ts`. Objects are strict so an agent's misspelt key comes
 * back as an issue instead of silently vanishing.
 */
import { z } from 'zod';

export const REVIEW_SCHEMA_VERSION = 4;

const text = z.string().refine((s) => s.trim().length > 0, 'nonempty string required');
const id = text;
const evidenceRefs = z.array(z.string()).min(1, 'evidence required');

export const changeStatusSchema = z.enum(['added', 'modified', 'removed', 'unchanged']);
export const evidenceKindSchema = z.enum(['observed', 'inferred', 'unknown', 'demo']);
export const fitStatusSchema = z.enum(['aligned', 'tension', 'unknown']);
export const subjectKindSchema = z.enum(['pr', 'spec']);
export const apiSurfaceSchema = z.enum(['http', 'export', 'event', 'cli', 'config', 'schema', 'extension-point', 'other']);
export const apiStatusSchema = z.enum(['added', 'modified', 'removed', 'deprecated']);

export const reviewMetaSchema = z.strictObject({
  title: text,
  subtitle: text,
  repository: text,
  /** The subject's label: `PR #123 · title` for a PR, the spec path for a spec. */
  pr: text,
  base: text,
  head: text,
  demo: z.boolean(),
  subject_kind: subjectKindSchema,
});

export const evidenceSchema = z.strictObject({
  id,
  kind: evidenceKindSchema,
  title: text,
  source: text,
  detail: text,
  url: z.string().optional(),
});

export const conditionSchema = z.strictObject({
  id,
  title: text,
  owner: text,
  verification: text,
  evidence: evidenceRefs,
  /** The api_changes this condition clears. Every breaking change must be named by one (R3). */
  api_changes: z.array(z.string()).optional(),
});

export const decisionSchema = z.strictObject({
  label: text,
  rationale: text,
  evidence: evidenceRefs,
  conditions: z.array(conditionSchema),
});

export const capabilitySchema = z.strictObject({
  id,
  status: z.enum(['added', 'modified', 'removed']),
  title: text,
  before: text,
  after: text,
  impact: text,
  components: z.array(z.string()).min(1, 'Capability components required'),
  evidence: evidenceRefs,
  /** Computed by validation (the one view that shows every component); ignored on input. */
  home_view: z.string().optional(),
});

export const nodeSchema = z.strictObject({
  id,
  label: text,
  kind: text,
  status: changeStatusSchema,
  before: text,
  after: text,
  impact: text,
  evidence: evidenceRefs,
});

export const edgeSchema = z.strictObject({
  id,
  from: text,
  to: text,
  label: text,
  status: changeStatusSchema,
  before_label: text.optional(),
  evidence: evidenceRefs,
});

export const MAX_VIEWS = 8;
export const MAX_ROW = 9;
export const MAX_PER_VIEW = 12;

export const placeSchema = z.strictObject({
  node: z.string(),
  col: z.number().int().min(0, 'Place col must be 0..2').max(2, 'Place col must be 0..2'),
  row: z.number().int().min(0, `Place row must be 0..${MAX_ROW}`).max(MAX_ROW, `Place row must be 0..${MAX_ROW}`),
});

export const viewSchema = z.strictObject({
  id,
  title: text,
  description: text,
  before_caption: text,
  after_caption: text,
  focus: z.string().optional(),
  places: z.array(placeSchema).min(2, 'places needs at least two components'),
});

export const architectureSchema = z.strictObject({
  headline: text,
  description: text,
  nodes: z.array(nodeSchema).min(1, 'architecture.nodes required'),
  edges: z.array(edgeSchema),
  views: z
    .array(viewSchema)
    .min(1, `architecture.views must hold 1..${MAX_VIEWS} diagram sections`)
    .max(MAX_VIEWS, `architecture.views must hold 1..${MAX_VIEWS} diagram sections`),
});

export const flowStepSchema = z.strictObject({
  id,
  label: text,
  component: text,
  status: changeStatusSchema,
});

export const flowLinkSchema = z.strictObject({ from: text, to: text, label: text });

export const flowDiagramSchema = z.strictObject({
  steps: z.array(flowStepSchema).min(1, 'Flow steps required'),
  links: z.array(flowLinkSchema),
});

export const flowSchema = z.strictObject({
  id,
  title: text,
  outcome: text,
  failure: text,
  evidence: evidenceRefs,
  before: flowDiagramSchema,
  after: flowDiagramSchema,
});

export const tradeoffSchema = z.strictObject({
  id,
  title: text,
  pro: text,
  con: text,
  alternative: text,
  evidence: evidenceRefs,
});

export const fitSchema = z.strictObject({
  id,
  title: text,
  status: fitStatusSchema,
  rule: text,
  assessment: text,
  evidence: evidenceRefs,
});

export const questionSchema = z.strictObject({
  id,
  owner: text,
  question: text,
  why: text,
  evidence: evidenceRefs,
});

/** One public surface the change touches (spec § Public API delta, R3). `breaking: 'unknown'` is
 *  the honest row for a surface the agent could not decide on — never guessed as safe. */
export const apiChangeSchema = z.strictObject({
  id,
  surface: apiSurfaceSchema,
  name: text,
  status: apiStatusSchema,
  breaking: z.union([z.boolean(), z.literal('unknown')]),
  /** Why it breaks (required when breaking) or why a removal does not (required then too). */
  impact: text.optional(),
  before: text.optional(),
  after: text.optional(),
  consumers: z.array(text).optional(),
  migration: text.optional(),
  evidence: evidenceRefs,
});

export const reviewModelSchema = z.strictObject({
  schema_version: z.literal(REVIEW_SCHEMA_VERSION, `schema_version must be ${REVIEW_SCHEMA_VERSION}`),
  meta: reviewMetaSchema,
  summary: text,
  scope_note: text,
  decision: decisionSchema,
  capabilities: z.array(capabilitySchema).min(1, 'capabilities cannot be empty'),
  architecture: architectureSchema,
  flows: z.array(flowSchema).min(1, 'flows cannot be empty'),
  tradeoffs: z.array(tradeoffSchema),
  fit: z.array(fitSchema).min(1, 'fit cannot be empty'),
  questions: z.array(questionSchema),
  api_changes: z.array(apiChangeSchema),
  evidence: z.array(evidenceSchema).min(1, 'evidence cannot be empty'),
});

export type ReviewModel = z.infer<typeof reviewModelSchema>;
export type ReviewEvidence = z.infer<typeof evidenceSchema>;
export type ReviewNode = z.infer<typeof nodeSchema>;
export type ReviewEdge = z.infer<typeof edgeSchema>;
export type ReviewView = z.infer<typeof viewSchema>;
export type ReviewCapability = z.infer<typeof capabilitySchema>;
export type ReviewFlow = z.infer<typeof flowSchema>;
export type ApiChange = z.infer<typeof apiChangeSchema>;
export type SubjectKind = z.infer<typeof subjectKindSchema>;
