/**
 * `cezar fleet …` — submit work to a fleet and look at it from a shell (spec
 * 2026-10-21-fleet-coordination). A thin client over the hub's fleet listener, addressed by
 * `CEZ_FLEET_HUB_URL` + `CEZ_FLEET_TOKEN` (on the hub itself: `CEZ_FLEET_HUB=1`, loopback).
 */
import { parseArgs } from 'node:util';
import {
  fleetJobSchema,
  fleetStatusResponseSchema,
  runnerSchema,
  type FleetJob,
  type FleetSubmit,
} from '@open-mercato/cezar-contract';
import { FLEET_DEFAULT_PORT } from './config.ts';
import { NODE_TTL_MS } from './scheduler.ts';
import { getRepoInfo } from '../server/git.ts';

export interface FleetCliEnv {
  CEZ_FLEET_HUB_URL?: string;
  CEZ_FLEET_HUB?: string;
  CEZ_FLEET_PORT?: string;
  CEZ_FLEET_TOKEN?: string;
}

export interface FleetCliIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  /** The repo URL to submit when `--repo` is absent (the cwd's remote). */
  defaultRepo?: () => Promise<string | undefined>;
}

const REQUEST_TIMEOUT_MS = 15_000;

const USAGE = `cezar fleet — hand work to a fleet of cezar instances (CEZ_FLEET_HUB_URL + CEZ_FLEET_TOKEN)

  cezar fleet submit "<task>" [--repo <url>] [--base <branch>] [--workflow <name>]
                    [--runner <id>] [--model <model>] [--no-pr]
                    queue a job; --repo defaults to this directory's git remote
  cezar fleet status [--json]     nodes and jobs
  cezar fleet cancel <jobId>      cancel a queued or running job`;

function hubBase(env: FleetCliEnv): string | null {
  const url = env.CEZ_FLEET_HUB_URL?.trim().replace(/\/+$/, '');
  if (url) return url;
  return env.CEZ_FLEET_HUB === '1' ? `http://127.0.0.1:${env.CEZ_FLEET_PORT || FLEET_DEFAULT_PORT}` : null;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return `${response.status} ${response.statusText}`;
}

function line(job: FleetJob): string {
  const where = job.nodeId ? `  @${job.nodeId}` : '';
  const result = job.prUrl ?? job.branch ?? '';
  const err = job.error ? `  (${job.error})` : '';
  return `${job.id.slice(0, 8)}  ${job.status.padEnd(9)}${where}  ${job.task.replace(/\s+/g, ' ').slice(0, 60)}${result ? `  ${result}` : ''}${err}`;
}

export async function runFleetCommand(
  args: string[],
  env: FleetCliEnv = process.env,
  io: FleetCliIo = { fetch, log: console.log, error: console.error, defaultRepo: async () => (await getRepoInfo(process.cwd()))?.remote },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || rest.includes('--help')) {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  const base = hubBase(env);
  if (!base || !env.CEZ_FLEET_TOKEN) {
    io.error('cezar fleet: set CEZ_FLEET_HUB_URL (the hub, e.g. http://cezar-hub:4330) and CEZ_FLEET_TOKEN — or CEZ_FLEET_HUB=1 on the hub itself');
    return 2;
  }
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await io.fetch(`${base}/api/v1/fleet${path}`, {
      ...init,
      headers: { authorization: `Bearer ${env.CEZ_FLEET_TOKEN}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  };

  try {
    if (command === 'submit') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          repo: { type: 'string' },
          base: { type: 'string' },
          workflow: { type: 'string' },
          runner: { type: 'string' },
          model: { type: 'string' },
          'no-pr': { type: 'boolean', default: false },
        },
      });
      const task = positionals.join(' ').trim();
      if (!task) throw new Error('give the task: cezar fleet submit "<task>" --repo <url>');
      const repoUrl = values.repo ?? (await io.defaultRepo?.());
      if (!repoUrl) throw new Error('--repo <url> is required (this directory has no git remote)');
      const runner = values.runner === undefined ? undefined : runnerSchema.parse(values.runner);
      const body: FleetSubmit = {
        repoUrl,
        task,
        ...(values.base ? { baseBranch: values.base } : {}),
        ...(values.workflow ? { workflowId: values.workflow } : {}),
        ...(runner ? { runner } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values['no-pr'] ? { openPr: false } : {}),
      };
      const job = fleetJobSchema.parse(await call('/jobs', { method: 'POST', body: JSON.stringify(body) }));
      io.log(`queued ${job.id}`);
      return 0;
    }
    if (command === 'status') {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean', default: false } } });
      const status = fleetStatusResponseSchema.parse(await call('/status'));
      if (values.json) {
        io.log(JSON.stringify(status, null, 2));
        return 0;
      }
      io.log(status.nodes.length === 0 ? 'no nodes' : 'nodes:');
      for (const n of status.nodes) {
        const stale = Date.now() - Date.parse(n.lastSeen) > NODE_TTL_MS ? '  STALE' : '';
        io.log(`  ${n.nodeId}  ${n.capacity.free}/${n.capacity.max} free  v${n.version}  seen ${n.lastSeen}${stale}`);
      }
      io.log(status.jobs.length === 0 ? 'no jobs' : 'jobs:');
      for (const job of status.jobs) io.log(`  ${line(job)}`);
      return 0;
    }
    if (command === 'cancel') {
      const id = rest[0];
      if (!id) throw new Error('give the job id: cezar fleet cancel <jobId>');
      // Accept the 8-char prefix `status` prints.
      const status = fleetStatusResponseSchema.parse(await call('/status'));
      const matches = status.jobs.filter((j) => j.id === id || j.id.startsWith(id));
      if (matches.length !== 1) throw new Error(matches.length === 0 ? `no job ${id}` : `${id} is ambiguous`);
      const job = fleetJobSchema.parse(await call(`/jobs/${encodeURIComponent((matches[0] as FleetJob).id)}/cancel`, { method: 'POST' }));
      io.log(`${job.id.slice(0, 8)}  ${job.status}`);
      return 0;
    }
    io.error(`cezar fleet: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  } catch (error) {
    io.error(`cezar fleet: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
