import type { TelemetryConsentPayload } from '@open-mercato/cezar-api-client'

/**
 * When the cockpit asks for telemetry consent (docs/telemetry.md): only a machine that has never
 * answered, and never where an env var or automation would block sending anyway. The ask is a
 * bar at the bottom of the main column, not a modal — it stays until answered and covers nothing.
 */

/** cezar's own write-up of what is sent, and the module that sends it. */
export const TELEMETRY_DOC_URL = 'https://github.com/open-mercato/cezar/blob/main/docs/telemetry.md'
export const TELEMETRY_CODE_URL =
  'https://github.com/open-mercato/cezar/blob/main/packages/cezar/src/telemetry.ts'

export function shouldAskForTelemetry(payload: TelemetryConsentPayload | undefined): boolean {
  return payload !== undefined && payload.consent === 'unknown' && payload.blockedBy === null
}
