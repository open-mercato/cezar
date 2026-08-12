import type { HealthResponse } from '@open-mercato/cezar-api-client'

export interface UsageMetricVisibility {
  tokens: boolean
  cost: boolean
}

/**
 * The one browser-side interpretation of the token/cost presentation capabilities.
 *
 * Missing health (still loading) and an older server without the additive fields both preserve
 * the historical visible default. The two new fields win independently; the legacy master is
 * only their fallback during version skew.
 */
export function usageMetricVisibility(
  // `Partial`, deliberately: the CONTRACT declares `tokenMetrics` required because this server
  // always sends it, so the absent case cannot be spelled with `Capabilities` itself. This helper
  // is the one place that tolerates version skew — a newer cockpit reading an older server — so
  // it is where the looser shape belongs.
  health: { capabilities?: Partial<HealthResponse['capabilities']> } | undefined,
): UsageMetricVisibility {
  const capabilities = health?.capabilities
  const legacy = capabilities?.tokenMetrics !== false
  return {
    tokens: capabilities?.tokenUsageMetrics ?? legacy,
    cost: capabilities?.costMetrics ?? legacy,
  }
}
