import type { HealthResponse } from '@open-mercato/cezar-api-client'

/**
 * The one browser-side interpretation of the token/cost presentation capability.
 *
 * Missing health (still loading) and an older server without the additive field both preserve
 * the historical visible default. Only an explicit `false` hides the metrics.
 */
export function tokenMetricsVisible(
  // `Partial`, deliberately: the CONTRACT declares `tokenMetrics` required because this server
  // always sends it, so the absent case cannot be spelled with `Capabilities` itself. This helper
  // is the one place that tolerates version skew — a newer cockpit reading an older server — so
  // it is where the looser shape belongs.
  health: { capabilities?: Partial<HealthResponse['capabilities']> } | undefined,
): boolean {
  return health?.capabilities?.tokenMetrics !== false
}
