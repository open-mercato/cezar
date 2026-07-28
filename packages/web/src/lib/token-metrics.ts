import type { HealthResponse } from '@open-mercato/cezar-api-client'

/**
 * The one browser-side interpretation of the token/cost presentation capability.
 *
 * Missing health (still loading) and an older server without the additive field both preserve
 * the historical visible default. Only an explicit `false` hides the metrics.
 */
export function tokenMetricsVisible(
  health: Pick<HealthResponse, 'capabilities'> | undefined,
): boolean {
  return health?.capabilities?.tokenMetrics !== false
}
