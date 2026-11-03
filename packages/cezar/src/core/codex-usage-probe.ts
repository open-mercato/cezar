import { createHash } from 'node:crypto';
import type { UsageAccountBinding, UsageWindowsObservation } from '@open-mercato/cezar-contract';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { profileDirState } from '../workspace/agent-profiles.ts';
import { CodexAppServerRpc, resolveCodexExecutable, spawnCodexAppServer, type CodexAppServerMessage } from './codex-app-server-transport.ts';
import { normalizeCodexUsageWindows } from './usage-windows.ts';

export interface CodexUsageProbeResult {
  binding: UsageAccountBinding;
  observation: UsageWindowsObservation;
}
const CACHE_MS = 15_000;
const TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CONCURRENT = 4;
/** null = the account answered without a bindable identity; UNAVAILABLE = no answer (timeout, saturation, crash). */
const UNAVAILABLE = 'unavailable';
type ProbeOutcome = CodexUsageProbeResult | null | typeof UNAVAILABLE;
const flights = new Map<string, Promise<ProbeOutcome>>();
const cache = new Map<string, { until: number; value: ProbeOutcome }>();

/** Preview-only, trusted resolved profile (never take a request path/env/executable).
 * Does not persist: caller binds/saves metadata and compares identity with the preview binding.
 * force bypasses the short result cache for identity revalidation, but still joins an in-flight read.
 */
export function probeCodexUsageWindows(profile: ResolvedAgentProfile, options: { force?: boolean; identityOnly?: boolean } = {}): Promise<CodexUsageProbeResult | null> {
  return probe(profile, options).then((value) => value === UNAVAILABLE ? null : value);
}

/** Launch revalidation (#1340): tells a definitive identity answer from a read that never answered,
 * so a timeout or a saturated probe is a retryable failure, not a changed account. */
export async function probeCodexIdentity(profile: ResolvedAgentProfile, { force = true }: { force?: boolean } = {}): Promise<{ identity: string | null } | { unavailable: true }> {
  const value = await probe(profile, { force, identityOnly: true });
  return value === UNAVAILABLE ? { unavailable: true } : { identity: value?.binding.identity ?? null };
}

function probe(profile: ResolvedAgentProfile, options: { force?: boolean; identityOnly?: boolean }): Promise<ProbeOutcome> {
  if (profile.provider !== 'codex' || process.env.CEZ_DRY_RUN === '1') return Promise.resolve(null);
  const key = JSON.stringify([profile.id, profile.path, options.identityOnly === true]);
  const pending = flights.get(key);
  if (pending) return pending.then((value) => structuredClone(value));
  const cached = cache.get(key);
  if (!options.force && cached && cached.until > Date.now()) return Promise.resolve(structuredClone(cached.value));
  if (flights.size >= MAX_CONCURRENT) return Promise.resolve(UNAVAILABLE);
  const work = readMetadata(profile, options.identityOnly).catch((): ProbeOutcome => UNAVAILABLE).then((value) => {
    // No answer is not an answer: the next caller must be free to ask again.
    if (value === UNAVAILABLE) return value;
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + CACHE_MS, value });
    return value;
  }).finally(() => { flights.delete(key); });
  flights.set(key, work);
  return work.then((value) => structuredClone(value));
}

async function readMetadata(profile: ResolvedAgentProfile, identityOnly = false): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  let checkTimer: NodeJS.Timeout | undefined;
  const valid = await Promise.race([
    profileDirState('codex', profile.path).then((state) => state.looksValid),
    new Promise<typeof UNAVAILABLE>((resolve) => { checkTimer = setTimeout(() => resolve(UNAVAILABLE), TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(checkTimer));
  if (valid !== true) return valid === UNAVAILABLE ? UNAVAILABLE : null;
  // No repo cwd: metadata discovery must not ingest repo-local configuration or tools.
  const child = spawnCodexAppServer(resolveCodexExecutable(), profile.path, { CODEX_HOME: profile.path });
  const rpc = new CodexAppServerRpc(child);
  let buffer = '';
  let bytes = 0;
  let settled = false;
  let stop!: () => void;
  const failure = new Promise<typeof UNAVAILABLE>((resolve) => { stop = () => { rpc.rejectPending('Usage metadata unavailable'); resolve(UNAVAILABLE); }; });
  const timer = setTimeout(stop, Math.max(1, TIMEOUT_MS - (Date.now() - startedAt)));
  child.once('error', stop);
  child.once('exit', stop);
  const count = (chunk: Buffer | string): boolean => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_OUTPUT_BYTES) { stop(); return false; }
    return true;
  };
  child.stderr.on('data', count); // count, never retain credentials/errors
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (settled || !count(chunk)) return;
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const msg = JSON.parse(line) as CodexAppServerMessage;
        if (msg && typeof msg === 'object') rpc.dispatchResponse(msg);
      } catch { /* bounded non-protocol output */ }
    }
  });
  try {
    return await Promise.race([failure, (async () => {
      await rpc.initialize();
      const account = await rpc.request('account/read', { refreshToken: false });
      const identity = codexIdentity(account.account);
      if (!identity) return null;
      const limits = identityOnly ? {} : await rpc.request('account/rateLimits/read', {});
      return {
        binding: { provider: 'codex' as const, accountId: profile.id, profilePath: profile.path, identity },
        observation: normalizeCodexUsageWindows(limits, 'codex-read'),
      };
    })()]);
  } finally {
    settled = true;
    clearTimeout(timer);
    rpc.rejectPending('Usage metadata probe finished');
    child.stdin.end();
    // A metadata-only child has no task to protect: immediate kill bounds teardown too.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

/** Hash only stable account metadata. API-key/no-identity accounts cannot be bound reliably. */
export function codexIdentity(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const account = value as Record<string, unknown>;
  if (account.type !== 'chatgpt' || typeof account.email !== 'string' || !account.email.trim()) return null;
  return createHash('sha256').update(JSON.stringify(['chatgpt', account.email.trim().toLowerCase(),
    typeof account.accountId === 'string' ? account.accountId : null])).digest('hex');
}
