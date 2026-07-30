import { describe, expect, it } from 'vitest'

import type { HealthResponse } from '@open-mercato/cezar-api-client'

import { usageMetricVisibility } from './token-metrics'

// Matches what the helper accepts, not the full contract type: the point of these cases is the
// absent field, which `Capabilities` no longer permits now that the server always sends it.
const health = (
  capabilities: Partial<HealthResponse['capabilities']> = {},
): { capabilities?: Partial<HealthResponse['capabilities']> } => ({
  capabilities: {
    localHandoff: true,
    followups: false,
    singleProject: false,
    ...capabilities,
  },
})

describe('usageMetricVisibility', () => {
  it('preserves the visible default while health is loading or comes from an older server', () => {
    expect(usageMetricVisibility(undefined)).toEqual({ tokens: true, cost: true })
    expect(usageMetricVisibility(health())).toEqual({ tokens: true, cost: true })
  })

  it.each([
    [{ tokenUsageMetrics: true, costMetrics: true }, { tokens: true, cost: true }],
    [{ tokenUsageMetrics: true, costMetrics: false }, { tokens: true, cost: false }],
    [{ tokenUsageMetrics: false, costMetrics: true }, { tokens: false, cost: true }],
    [{ tokenUsageMetrics: false, costMetrics: false }, { tokens: false, cost: false }],
  ] as const)('resolves independent token and cost flags for %o', (capabilities, expected) => {
    expect(usageMetricVisibility(health(capabilities))).toEqual(expected)
  })

  it('uses the legacy master only when a new capability is absent', () => {
    expect(usageMetricVisibility(health({ tokenMetrics: false, tokenUsageMetrics: true }))).toEqual({
      tokens: true,
      cost: false,
    })
  })
})
