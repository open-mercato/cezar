import {
  fleetJobSchema,
  fleetStatusResponseSchema,
  type FleetJob,
  type FleetStatusResponse,
} from '@open-mercato/cezar-contract';
import type { FleetHub } from './hub.ts';

/**
 * What the cockpit's Fleet panel reads (spec 2026-10-21-fleet-coordination): the hub's state,
 * directly on a hub and over the token-guarded listener on a worker. The cockpit server holds the
 * token; the browser only ever sees the result. `startFleet` registers the view, so a cezar with no
 * fleet role has none and the panel stays hidden.
 */
export interface FleetView {
  role: 'hub' | 'worker';
  nodeId: string;
  status(): Promise<FleetStatusResponse>;
  /** `undefined` when the hub does not know the job. */
  cancel(jobId: string): Promise<FleetJob | undefined>;
}

let current: FleetView | undefined;

export const getFleetView = (): FleetView | undefined => current;
export const setFleetView = (view: FleetView | undefined): void => {
  current = view;
};

export function hubView(hub: FleetHub, nodeId: string): FleetView {
  return { role: 'hub', nodeId, status: async () => hub.status(), cancel: async (id) => hub.cancel(id) };
}

const TIMEOUT_MS = 10_000;

export function remoteView(hubUrl: string, token: string, nodeId: string, fetchImpl: typeof fetch = fetch): FleetView {
  const call = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${hubUrl}/api/v1/fleet${path}`, { ...init, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return {
    role: 'worker',
    nodeId,
    async status() {
      const res = await call('/status');
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return fleetStatusResponseSchema.parse(await res.json());
    },
    async cancel(id) {
      const res = await call(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return fleetJobSchema.parse(await res.json());
    },
  };
}
