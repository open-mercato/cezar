/**
 * Zero-config simlock (spec 2026-10-30-simlock-zero-config): `simlock` on PATH is the whole setup.
 * Each task then gets its own device identity, is told the tool exists, and has its lease given
 * back when it settles. Without the binary every export here is a no-op, so the agent env and
 * system prompt stay byte-for-byte what they were.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { z } from 'zod';

const RELEASE_TIMEOUT_MS = 10_000;

export const SIMLOCK_PROMPT = `Mobile devices. simlock is installed on this machine: it leases iOS simulators and Android emulators to parallel agents, one device per task. When this task needs a device, run \`simlock instructions\` first and follow it instead of creating or booting one with simctl, adb or emulator yourself. Your identity is already set (SIMLOCK_AGENT_ID, AGENT_DEVICE_SESSION): do not change it and do not pass --agent-id. A lease can wait minutes in the queue, so give the command a long timeout. Never run \`simlock release --all\` or \`simlock nuke\`: they end other tasks' leases. cezar releases this task's remaining lease when the task settles.`;

export function simlockAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CEZ_SIMLOCK === '0' || env.CEZ_DRY_RUN === '1') return false;
  return (env.PATH ?? '').split(delimiter).some((dir) => {
    if (!dir) return false;
    const candidate = join(dir, 'simlock');
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function simlockAgentId(runId: string): string {
  return `cezar:${runId}`;
}

/** One requester per task, whatever the runner — simlock otherwise falls back to one per command. */
export function simlockAgentEnv(runId: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!simlockAvailable(env)) return {};
  return { SIMLOCK_AGENT_ID: simlockAgentId(runId), AGENT_DEVICE_SESSION: `cezar-${runId}` };
}

// Only a stopped daemon answers with `status`; a running one prints its devices and leases.
const daemonStatusSchema = z.object({ status: z.string().optional() }).passthrough();
const leaseListSchema = z.array(z.object({ id: z.string(), requesterId: z.string() }).passthrough());

export type SimlockExec = (args: string[]) => Promise<string>;

const execSimlock: SimlockExec = (args) =>
  new Promise((resolve, reject) => {
    execFile('simlock', args, { timeout: RELEASE_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/**
 * Give back what this task still holds, returning the released lease ids. Never throws: the
 * lease's own TTL is the backstop, so a failure here only delays the device. `daemon status` comes
 * first because `list` would start a stopped daemon just to find nothing.
 */
export async function releaseSimlockLeases(runId: string, exec: SimlockExec = execSimlock): Promise<string[]> {
  try {
    const daemon = daemonStatusSchema.parse(JSON.parse(await exec(['daemon', 'status', '--json'])));
    if (daemon.status === 'stopped') return [];
    const leases = leaseListSchema.parse(JSON.parse(await exec(['list', '--leases'])));
    const mine = leases.filter((lease) => lease.requesterId === simlockAgentId(runId)).map((lease) => lease.id);
    const results = await Promise.allSettled(mine.map((id) => exec(['release', id])));
    return mine.filter((_, index) => results[index]?.status === 'fulfilled');
  } catch {
    return [];
  }
}
