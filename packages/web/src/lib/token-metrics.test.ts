import { describe, expect, it } from 'vitest'

import type { HealthResponse } from '@open-mercato/cezar-api-client'

import { tokenMetricsVisible } from './token-metrics'

const health = (tokenMetrics?: boolean): Pick<HealthResponse, 'capabilities'> => ({
  capabilities: {
    localHandoff: true,
    followups: false,
    singleProject: false,
    ...(tokenMetrics === undefined ? {} : { tokenMetrics }),
  },
})

describe('tokenMetricsVisible', () => {
  it('preserves the visible default while health is loading or comes from an older server', () => {
    expect(tokenMetricsVisible(undefined)).toBe(true)
    expect(tokenMetricsVisible(health())).toBe(true)
  })

  it('hides metrics only for the explicit false capability', () => {
    expect(tokenMetricsVisible(health(true))).toBe(true)
    expect(tokenMetricsVisible(health(false))).toBe(false)
  })
})
