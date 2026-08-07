import { describe, expect, it } from 'vitest'
import { healthResponseSchema, type HealthResponse } from '@open-mercato/cezar-api-client'

/**
 * The `sync-contract` pipeline, end to end.
 *
 * `packages/cezar/src/contract/` is copied into the api-client at prebuild and compiled into its
 * dist, so the cockpit gets the zod SCHEMA (a runtime value) and not merely the inferred type. If
 * the copy step regressed, or the api-client stopped re-exporting it, the import below fails to
 * resolve and this file goes red — which is the only place that would notice.
 */
describe('the contract reaches the cockpit as BOTH a schema and a type', () => {
  it('validates at runtime', () => {
    const ok = healthResponseSchema.safeParse({
      version: '1', repoRoot: '/r', repo: null, checks: [], defaultRunner: 'claude',
      forge: null, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false },
      projects: [], bootProject: 'default',
    })
    expect(ok.success).toBe(true)
    expect(healthResponseSchema.safeParse({ version: 1 }).success).toBe(false)
  })
  it('infers the type from that same schema', () => {
    const h: HealthResponse = {
      version: '1', repoRoot: '/r', repo: null, checks: [], defaultRunner: 'claude',
      forge: null, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false },
      projects: [], bootProject: 'default',
    }
    expect(h.defaultRunner).toBe('claude')
  })
})
