/**
 * Per-project automatic agent fallback policy (spec 2026-10-20-agent-usage-limit-fallback).
 *
 * One file, `cezarHomeDir()/agent-fallback.json`, keyed by project root. Every write goes through a
 * cross-process lock and a revision/incarnation compare-and-swap; reads salvage valid entries one
 * at a time so one corrupt project never resets the others.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import lockfile from 'proper-lockfile';
import { agentFallbackPolicyPath, assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';
import { PROVIDER_IDS, type ProviderId } from '../core/provider-auth.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts, type AgentAccountStore } from './agent-accounts.ts';

export type AgentFallbackCandidate = { provider: ProviderId; profileId: string; model?: string };
export type AgentFallbackPolicy = {
  enabled: boolean; candidates: AgentFallbackCandidate[]; revision: number;
  incarnation: string | null; revocation: string | null;
};

const candidateSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  profileId: z.string().min(1).max(64).default(DEFAULT_AGENT_ACCOUNT_ID),
  model: z.string().min(1).max(200).optional(),
}).passthrough();
const entrySchema = z.object({
  enabled: z.boolean().catch(false),
  candidates: z.array(candidateSchema).max(10).catch(() => []),
  revision: z.number().int().nonnegative().catch(0),
  incarnation: z.string().nullable().catch(null),
  revocation: z.string().nullable().catch(null),
}).passthrough();
type Store = { version: number; projects: Record<string, z.infer<typeof entrySchema>>; [key: string]: unknown };

const emptyPolicy = (): AgentFallbackPolicy => ({ enabled: false, candidates: [], revision: 0, incarnation: null, revocation: null });
/** An owner-less lock older than this is a crash between mkdir and the owner write. */
const ORPHAN_LOCK_MS = 30_000;

/** One spelling per project: the route and the RunManager may reach the same repo by different paths. */
const projectKey = (root: string): string => { try { return realpathSync(root); } catch { return root; } };

export const candidateKey = (c: { provider: string; profileId?: string }): string =>
  `${c.provider}:${c.profileId ?? DEFAULT_AGENT_ACCOUNT_ID}`;

/** The exact contract shape — unknown fields kept in the file never reach the wire. */
function toPolicy(entry: AgentFallbackPolicy): AgentFallbackPolicy {
  return {
    enabled: entry.enabled,
    candidates: entry.candidates.map((c) => ({ provider: c.provider, profileId: c.profileId, ...(c.model ? { model: c.model } : {}) })),
    revision: entry.revision,
    incarnation: entry.incarnation,
    revocation: entry.revocation,
  };
}

function validateCandidates(candidates: AgentFallbackCandidate[]): AgentFallbackCandidate[] {
  const parsed = z.array(candidateSchema).max(10).safeParse(candidates);
  if (!parsed.success) throw new FallbackPolicyInputError('invalid fallback candidate');
  const seen = new Set<string>();
  for (const item of parsed.data) {
    if (seen.has(candidateKey(item))) throw new FallbackPolicyInputError('duplicate fallback candidate');
    seen.add(candidateKey(item));
  }
  return parsed.data.map((c) => ({ provider: c.provider, profileId: c.profileId, ...(c.model ? { model: c.model } : {}) }));
}

export class FallbackPolicyInputError extends Error {}
export class FallbackPolicyBusyError extends Error {
  constructor() { super('fallback policy is being edited by another cezar process; retry later'); }
}

/** pid plus the kernel's start tick where available, so a reused pid is not mistaken for the owner. */
function processIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}

function ownerIsDead(owner: string): boolean {
  const [pidText, start] = owner.split(':');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  // Alive pid: still dead to us when it is a different process than the one that took the lock.
  const current = processIdentity(pid);
  return Boolean(start && current && start !== current);
}

function tryAcquireLock(path: string): boolean {
  // Build the lock with its owner inside, then rename into place: a lock is never owner-less
  // except when it predates this code or a crash left the rename target behind.
  const staging = `${path}.${process.pid}.${randomUUID()}`;
  mkdirSync(staging, { mode: 0o700 });
  writeFileSync(`${staging}/owner`, `${process.pid}:${processIdentity(process.pid) ?? ''}`, { mode: 0o600 });
  try {
    renameSync(staging, path);
    return true;
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

/** Move a stale lock aside, but only the one judged stale: a fresh lock another reclaimer installed
 *  in between is put back untouched. */
function reclaimStaleLock(path: string): void {
  const judged = staleOwner(path);
  if (judged === null) return;
  const aside = `${path}.stale.${randomUUID()}`;
  try { renameSync(path, aside); } catch { return; }
  if ((readOwner(aside) ?? '') !== judged) {
    // We moved a live lock: put it back. If the slot was retaken meanwhile, leaving it aside is the
    // lesser harm — its owner's release is a no-op and the newcomer holds the real lock.
    try { renameSync(aside, path); } catch { /* see above */ }
    return;
  }
  rmStaleSiblings(path);
}

async function acquireLock(policyPath: string): Promise<() => void> {
  const path = `${policyPath}.lock`;
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 10; attempt++) {
    // Serialize both stale reclamation and the policy transaction. No await is allowed while
    // this guard is held: another reclaimer can never move a newly acquired live owner aside.
    let releaseGuard: (() => void) | undefined;
    try {
      releaseGuard = lockfile.lockSync(path, {
        realpath: false, lockfilePath: `${path}.guard`, stale: 15_000,
      });
      if (!tryAcquireLock(path)) reclaimStaleLock(path);
      else return () => { releaseLock(path); releaseGuard!(); };
      if (tryAcquireLock(path)) return () => { releaseLock(path); releaseGuard!(); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') { releaseGuard?.(); throw error; }
    }
    releaseGuard?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new FallbackPolicyBusyError();
}

function readOwner(path: string): string | null {
  try { return readFileSync(`${path}/owner`, 'utf8').trim(); } catch { return null; }
}

/** The owner string of a stale lock ('' for an old owner-less orphan), or null when it is live. */
function staleOwner(path: string): string | null {
  const owner = readOwner(path);
  if (owner !== null) return ownerIsDead(owner) ? owner : null;
  try { return Date.now() - statSync(path).mtimeMs > ORPHAN_LOCK_MS ? '' : null; } catch { return null; }
}

function rmStaleSiblings(path: string): void {
  try {
    const dir = dirname(path);
    const base = path.slice(dir.length + 1);
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${base}.stale.`)) rmSync(`${dir}/${name}`, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

function releaseLock(path: string): void { rmSync(path, { recursive: true, force: true }); }

function parseStore(raw: string): Store {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const projects: Store['projects'] = {};
  const rows = value && typeof value.projects === 'object' && value.projects !== null ? value.projects as Record<string, unknown> : {};
  for (const [root, row] of Object.entries(rows)) {
    const parsed = entrySchema.safeParse(row);
    if (parsed.success) projects[root] = parsed.data;
  }
  return { ...value, version: typeof value.version === 'number' ? value.version : 1, projects };
}

async function load(path: string): Promise<Store> {
  try { return parseStore(await readFile(path, 'utf8')); } catch { return { version: 1, projects: {} }; }
}

function loadSync(path: string): Store {
  try { return parseStore(readFileSync(path, 'utf8')); } catch { return { version: 1, projects: {} }; }
}

export async function getAgentFallbackPolicy(root: string): Promise<AgentFallbackPolicy> {
  const key = projectKey(root);
  return toPolicy((await load(agentFallbackPolicyPath())).projects[key] ?? emptyPolicy());
}

export function getAgentFallbackPolicySync(root: string): AgentFallbackPolicy {
  return toPolicy(loadSync(agentFallbackPolicyPath()).projects[projectKey(root)] ?? emptyPolicy());
}

/**
 * Compare-and-swap write. Throws `FallbackPolicyInputError` (400), `FallbackPolicyBusyError` (409);
 * anything else is an I/O failure (500).
 */
export async function putAgentFallbackPolicy(root: string, input: {
  expectedRevision: number; expectedIncarnation: string | null; enabled: boolean; candidates: AgentFallbackCandidate[];
}): Promise<AgentFallbackPolicy | { conflict: true }> {
  const candidates = validateCandidates(input.candidates);
  if (input.enabled && candidates.length === 0) throw new FallbackPolicyInputError('fallback policy requires at least one candidate');
  const path = agentFallbackPolicyPath();
  const key = projectKey(root);
  const lock = await acquireLock(path);
  try {
    const s = loadSync(path);
    const current = s.projects[key] ?? emptyPolicy();
    if (current.revision !== input.expectedRevision || current.incarnation !== input.expectedIncarnation) return { conflict: true };
    const next: AgentFallbackPolicy = {
      enabled: input.enabled,
      candidates,
      revision: current.revision + 1,
      // A fresh consent episode on every off→on edge; disabling rotates the revocation token so
      // snapshots taken under the old consent stop launching successors.
      incarnation: input.enabled && !current.enabled ? randomUUID() : (current.incarnation ?? randomUUID()),
      revocation: input.enabled ? current.revocation : (current.enabled ? randomUUID() : current.revocation),
    };
    // Preserve newer-version metadata on retained identities without exposing it over the API.
    // Explicit Auto removes the old model pin, even though unknown fields survive.
    const retained = new Map(current.candidates.map((candidate) => [candidateKey(candidate), candidate]));
    s.projects[key] = { ...current, ...next, candidates: candidates.map((candidate) => ({
      ...retained.get(candidateKey(candidate)), model: undefined, ...candidate,
    })) };
    atomicWriteJsonSync(path, s);
    return next;
  } finally { lock(); }
}

/** A snapshot still carries the consent that is live now. */
export function fallbackConsentCurrent(snapshot: AgentFallbackPolicy, live: AgentFallbackPolicy): boolean {
  return live.enabled && live.incarnation === snapshot.incarnation && live.revocation === snapshot.revocation;
}

export type FallbackSkip = { candidate: AgentFallbackCandidate; reason: string };

/**
 * The ordered candidates still eligible in this episode: never one already attempted (the task's
 * own starting agent included), never an account waiting out a usage limit, never an account that
 * no longer exists for that provider. Skips are returned with their reason for the transcript.
 */
export function eligibleFallbackCandidates(
  policy: AgentFallbackPolicy,
  attempted: ReadonlySet<string>,
  heldAccounts: ReadonlySet<string>,
  accounts: AgentAccountStore | null,
): { eligible: AgentFallbackCandidate[]; skipped: FallbackSkip[] } {
  const eligible: AgentFallbackCandidate[] = [];
  const skipped: FallbackSkip[] = [];
  if (!policy.enabled) return { eligible, skipped };
  for (const candidate of policy.candidates) {
    const key = candidateKey(candidate);
    if (attempted.has(key)) continue;
    if (heldAccounts.has(key)) { skipped.push({ candidate, reason: 'waiting out its own usage limit' }); continue; }
    if (candidate.profileId !== DEFAULT_AGENT_ACCOUNT_ID) {
      // Fail closed: an account we cannot confirm is never swapped for the default login.
      const known = accounts?.accounts.some((a) => a.id === candidate.profileId && a.provider === candidate.provider);
      if (!known) { skipped.push({ candidate, reason: 'account no longer exists' }); continue; }
    }
    eligible.push(candidate);
  }
  return { eligible, skipped };
}

/** Accounts for fallback admission; `null` when unreadable, which makes every named account fail closed. */
export async function loadFallbackAccounts(): Promise<AgentAccountStore | null> {
  return loadAgentAccounts().catch(() => null);
}
