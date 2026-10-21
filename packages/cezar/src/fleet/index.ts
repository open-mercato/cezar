import { fleetHeartbeatResponseSchema, type FleetHeartbeat, type FleetHeartbeatResponse } from '@open-mercato/cezar-contract';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { FleetConfig } from './config.ts';
import { FleetHub } from './hub.ts';
import { loadJobs, saveJobs } from './jobs-store.ts';
import { createFleetRunHost, type BootProject } from './runs.ts';
import { startFleetServer } from './server.ts';
import { FleetWorker } from './worker.ts';

/** How often the hub looks for expired leases between heartbeats. */
const SWEEP_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Free slots on this node. Written so it can switch to `semaphore.freeCapacity()` once that lands. */
export function localCapacity(semaphore: Pick<WorkspaceSemaphore, 'maxParallel' | 'busy'>): { free: number; max: number } {
  const max = semaphore.maxParallel();
  return { free: Math.max(0, max - semaphore.busy()), max };
}

/** Worker -> hub transport: authenticated JSON over HTTP, response validated at the boundary. */
export function httpTransport(hubUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  return async (heartbeat: FleetHeartbeat): Promise<FleetHeartbeatResponse> => {
    const response = await fetchImpl(`${hubUrl}/api/v1/fleet/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(heartbeat),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
    return fleetHeartbeatResponseSchema.parse(await response.json());
  };
}

export interface StartFleetDeps {
  config: Exclude<FleetConfig, { role: 'off' } | { role: 'invalid' }>;
  version: string;
  semaphore: WorkspaceSemaphore;
  boot: BootProject;
  context: (projectId: string) => Promise<ProjectContext>;
  log?: (message: string) => void;
}

/** Start this node's fleet role. Returns the stop handle; a hub also starts its fleet listener. */
export function startFleet(deps: StartFleetDeps): { stop(): void } {
  const { config, log = console.log } = deps;
  const stops: Array<() => void> = [];
  let transport: (heartbeat: FleetHeartbeat) => Promise<FleetHeartbeatResponse>;
  if (config.role === 'hub') {
    const hub = new FleetHub({ initialJobs: loadJobs(), persist: saveJobs });
    const server = startFleetServer(hub, config.token, config.port, config.bind);
    const sweep = setInterval(() => hub.sweep(), SWEEP_MS);
    sweep.unref();
    stops.push(() => {
      clearInterval(sweep);
      server.close();
    });
    // The hub is a node too: same worker loop, heartbeating straight into the hub.
    transport = async (heartbeat) => hub.heartbeat(heartbeat);
    log(`  fleet hub → :${config.port} (${config.bind}) as node ${config.nodeId}`);
  } else {
    transport = httpTransport(config.hubUrl, config.token);
    log(`  fleet worker → ${config.hubUrl} as node ${config.nodeId}`);
  }
  const worker = new FleetWorker({
    nodeId: config.nodeId,
    version: deps.version,
    host: createFleetRunHost({ boot: deps.boot, context: deps.context }),
    transport,
    capacity: () => localCapacity(deps.semaphore),
    log,
  });
  worker.start();
  stops.push(() => worker.stop());
  return { stop: () => stops.forEach((stop) => stop()) };
}
