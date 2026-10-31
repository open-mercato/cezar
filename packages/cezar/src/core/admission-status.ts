import type { AdmissionLevel } from './admission-governor.ts';

/**
 * The governor's snapshot, as the telemetry payload reports it (spec
 * `.ai/specs/2026-09-20-adaptive-admission-governor.md`, A7).
 *
 * One direction only: the semaphore OWNS the governor and registers a provider here; the sampler
 * READS the snapshot and never decides anything. Keeping the arrow one-way is what stops the
 * display path from becoming a control input - the same rule F12 pins for the memory numbers.
 *
 * The snapshot is absent when no `dispatchMaxConcurrent` ceiling is configured: there is nothing to
 * reduce, so the payload carries no `admission` key and a workspace that never set a ceiling sees
 * byte-identical telemetry.
 */

export interface AdmissionStatus {
  state: AdmissionLevel;
  /** The user's ceiling. */
  configured: number;
  /** What the admission gate was enforcing when this sample was taken (`configured` or lower);
   *  a cached route read can lag the live gate by up to the sampler's freshness window. */
  effective: number;
  /** ISO-8601 instant the current state began (absent while `normal`). */
  since?: string;
}

type Provider = () => AdmissionStatus | undefined;

let provider: Provider | undefined;

/** Registered by the shared workspace semaphore - the one writer. */
export function setAdmissionStatusProvider(next: Provider | undefined): void {
  provider = next;
}

/** The sampler's read: fresh when a semaphore is registered, absent otherwise. */
export function admissionStatusSnapshot(): AdmissionStatus | undefined {
  try {
    return provider?.();
  } catch {
    // Telemetry is never allowed to fail the sampler tick.
    return undefined;
  }
}
