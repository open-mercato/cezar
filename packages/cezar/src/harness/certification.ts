import { z } from 'zod';

/**
 * Eval-gate certification (spec 2026-08-06-eval-gated-model-routing, Phase 1).
 *
 * A certification is recorded evidence that a model binding passed the
 * role-mapped slice of an eval pack's deterministic case suite — the OM
 * standalone harness (`pack: 'omh'`, 203 cases with routing/AST/behavior
 * oracles) is the first pack, and the field exists precisely so it is not the
 * last. Entries live under `agentHarness.certifications` in
 * `.ai/agentic.config.json`, keyed by the same binding ids as
 * `agentHarness.models`; they are written only by the certify lane and the
 * setup skill. Cezar reads them to answer "why is this model seated here" —
 * it never writes them, and it never phones anywhere to check one.
 *
 * A missing or unparseable entry is 'uncertified', not an error: the gate
 * must never make an existing configuration stop loading, and an honest
 * "no evidence" beats a rejected config.
 */
export const certificationRoleSchema = z.object({
  cases: z.number().int().min(0),
  passed: z.number().int().min(0),
});

export const certificationSchema = z.object({
  /** The eval pack that produced this — 'omh' is the OM standalone harness catalog. */
  pack: z.string().min(1),
  catalogVersion: z.string().min(1),
  binding: z.object({
    family: z.string().min(1),
    model: z.string().min(1),
    adapter: z.string().min(1),
  }),
  roles: z
    .object({
      orchestrator: certificationRoleSchema.optional(),
      implementer: certificationRoleSchema.optional(),
      reviewer: certificationRoleSchema.optional(),
    })
    .refine((roles) => roles.orchestrator || roles.implementer || roles.reviewer, {
      message: 'a certification must cover at least one role',
    }),
  recordedAt: z.string().datetime(),
  /** sha256 of the sanitized result set the score was computed from. */
  resultDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ModelCertification = z.infer<typeof certificationSchema>;
export type CertificationRole = keyof ModelCertification['roles'];
export type CertificationStatus = 'certified' | 'stale' | 'uncertified';

/**
 * Past this, a recorded pass stops being evidence: providers move models
 * underneath their ids (gateway free tiers most of all), so a score without a
 * recent date would quietly become the same faith-based routing the gate
 * exists to replace. Staleness only ever downgrades the label — it never
 * blocks a run.
 */
export const CERTIFICATION_FRESH_MS = 90 * 24 * 60 * 60_000;

export interface ResolvedCertification {
  status: CertificationStatus;
  roles?: ModelCertification['roles'];
  pack?: string;
  catalogVersion?: string;
  recordedAt?: string;
}

/** The recorded certification for one binding id, resolved against `now`. */
export function certificationFor(
  modelId: string,
  agentHarness: Record<string, unknown> | undefined,
  now: Date,
): ResolvedCertification {
  const table = agentHarness?.certifications;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { status: 'uncertified' };
  const parsed = certificationSchema.safeParse((table as Record<string, unknown>)[modelId]);
  if (!parsed.success) return { status: 'uncertified' };
  const cert = parsed.data;
  const fresh = now.getTime() - Date.parse(cert.recordedAt) <= CERTIFICATION_FRESH_MS;
  return {
    status: fresh ? 'certified' : 'stale',
    roles: cert.roles,
    pack: cert.pack,
    catalogVersion: cert.catalogVersion,
    recordedAt: cert.recordedAt,
  };
}
