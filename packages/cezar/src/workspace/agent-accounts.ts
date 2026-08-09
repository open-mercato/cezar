import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-contract';
import { PROVIDER_IDS, type ProviderId } from '../core/provider-auth.ts';
import { supportsProfiles } from '../core/agent-profiles.ts';
import { agentAccountsPath, workspaceConfigPath } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

/**
 * `~/.cezar/agent-accounts.json` — the agent-accounts store (spec `2026-07-29-agent-profiles.md`).
 *
 * ## Why its own file
 *
 * These keys started life in `config.json`, where their survival across a cezar downgrade rested
 * on a `.passthrough()` modifier in the OTHER version's schema. That held for the versions in
 * this repo's history — measured, not assumed — but it is not a guarantee this repo can make on
 * behalf of a build someone switches to, and it fails completely in the one case that matters
 * most: any version that cannot parse `config.json` degrades to in-memory defaults, and its next
 * merge-write rewrites the file without whatever it did not understand.
 *
 * A version that has never heard of accounts does not open THIS file, so it cannot lose them.
 * That is the entire argument, and it is why the selections live here too rather than on the
 * project registry.
 *
 * ## House rules (the same ones `config.json` follows, for the same reasons)
 *
 * - every field optional/defaulted with `.catch`, so a bad value degrades per key;
 * - `.passthrough()` at every object level, so a NEWER cezar's keys survive an older one;
 * - per-entry salvage for `accounts` — one hand-edited row never evicts the rest;
 * - atomic tmp+rename at `0600` through the shared writer;
 * - a corrupt or unreadable file degrades to empty with ONE warning, never a boot failure.
 *
 * ## Identity
 *
 * Selections are keyed by the project's REALPATH'D ROOT, not its registry slug. The root is what
 * every consumer already has in hand (`resolveProfileEnvForRoot` takes it), it survives the
 * registry being rebuilt, and it means this file needs no cross-reference into `config.json` at
 * all. An orphaned entry — a project the user deregistered — resolves to nothing and is inert.
 */

/** `id` slug rule — the project rule, for the same URL/segment-safety reason. */
export const AGENT_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Reserved id meaning "the dir cezar discovers" (`agentHomePaths()`).
 *
 * NEVER stored and never allocated: the default account is the zero-config answer, so an absent
 * file behaves exactly as cezar always has. Materializing it would turn a discovered fact into
 * state a user has to maintain.
 *
 * Re-exported from the contract rather than spelled again here: the cockpit sends this exact string
 * to mean "the discovered account, whatever the repo is set to", so a second definition is a place
 * for the two sides to drift apart silently.
 */
export { DEFAULT_AGENT_ACCOUNT_ID };

/**
 * Is `configDir` absolute on `platform`? The account routes' only path rule, and the reason it is a
 * named function rather than a test written inline.
 *
 * A relative dir would resolve against whatever cwd the agent happens to be spawned in — for a task
 * that is a throwaway worktree — so it has to be refused. But the obvious spelling of that refusal,
 * a leading-`/` test, refuses every real Windows path too: `C:\Users\me\.claude-work` starts with
 * neither `/` nor `~`. That is not a corner case: `core/shell-env.ts` renders `set "VAR=v"` for
 * `cmd.exe` precisely so an account survives a Windows terminal handoff, and the Add-account dialog
 * delegates ALL path validation to the server, so a string test would leave the whole feature
 * unreachable on the one platform the rest of this work went out of its way to support.
 *
 * `platform` is a parameter so both answers stay testable from either OS.
 */
export function isAbsoluteConfigDir(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (platform === 'win32' ? win32 : posix).isAbsolute(configDir);
}

/** C0 controls + DEL. A path containing one is never legitimate and would be interpolated into a
 *  shell command by the CLI handoff, so it is refused at the schema, not just at the route. */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * One extra config dir for a provider — a second login of the same CLI
 * (`CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`), see `src/core/agent-profiles.ts`.
 *
 * `id`, `provider` and `configDir` are load-bearing and carry no `.catch`: a row missing any of
 * them names no account, so the per-entry salvage below drops it. Display fields degrade per key.
 *
 * `configDir` is stored AS WRITTEN — a literal `~` survives — and every consumer expands it
 * through `expandTilde`.
 */
const agentAccountSchema = z
  .object({
    id: z.string().regex(AGENT_ACCOUNT_ID_RE).refine((v) => v !== DEFAULT_AGENT_ACCOUNT_ID, {
      message: `"${DEFAULT_AGENT_ACCOUNT_ID}" is reserved for the discovered account`,
    }),
    // Refused at the SCHEMA, not just at the route, for the same reason the reserved `default` id
    // is: this file is designed to survive hand edits, foreign writers and the legacy import, and a
    // provider whose credentials do not follow its config dir resolves to a LIE — `profileEnv`
    // returns `{}` for it, so the step records the account, the UI names it, and the CLI runs on
    // the default login anyway. Dropped by the per-entry salvage instead, which is the one
    // degradation that cannot mislead.
    provider: z.enum(PROVIDER_IDS).refine(supportsProfiles, {
      message: 'this agent cannot carry more than one account (its credentials do not follow its config dir)',
    }),
    configDir: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !CONTROL_CHARS_RE.test(v), 'configDir must not contain control characters'),
    label: z.string().max(200).catch(''),
    addedAt: z.string().max(64).catch(''),
  })
  .passthrough();

export type AgentAccount = z.infer<typeof agentAccountSchema>;

/** One project's choice, per provider. Explicit keys so `PROVIDER_IDS` stays the one source of
 *  truth and the value is bounded. An absent key means the discovered default. */
const selectionSchema = z
  .object({
    claude: z.string().max(64).optional().catch(undefined),
    codex: z.string().max(64).optional().catch(undefined),
    opencode: z.string().max(64).optional().catch(undefined),
  })
  .passthrough();

export type AgentAccountSelection = z.infer<typeof selectionSchema>;

const storeSchema = z
  .object({
    /** Format cursor for THIS file, independent of `config.json`'s `schemaVersion`. Nothing reads
     *  it yet; it exists so a future shape change has somewhere to say so. */
    version: z.number().int().min(0).default(1).catch(1),
    accounts: z
      .array(z.unknown())
      .default(() => [])
      .catch(() => [])
      .transform((entries) => {
        const seen = new Set<string>();
        return entries.flatMap((entry) => {
          const parsed = agentAccountSchema.safeParse(entry);
          // First-wins on a duplicated id, so two consumers never resolve the same id differently.
          if (!parsed.success || seen.has(parsed.data.id)) return [];
          seen.add(parsed.data.id);
          return [parsed.data];
        });
      }),
    /**
     * The per-provider account a repo with no selection of its own uses.
     *
     * A machine-wide answer to "which login do I work under", so a second account does not have to
     * be re-chosen for every checkout. Consulted only where `selections` is silent for that repo
     * and provider — a repo that HAS chosen keeps its choice, which is what makes this a default
     * rather than an override.
     */
    defaults: selectionSchema.default(() => ({})).catch(() => ({})),
    /** Repo root → per-provider choice. Per-entry salvage: a bad row is dropped, the rest stay. */
    selections: z
      .record(z.string(), z.unknown())
      .default(() => ({}))
      .catch(() => ({}))
      .transform((raw) => {
        const out: Record<string, AgentAccountSelection> = {};
        for (const [root, value] of Object.entries(raw)) {
          const parsed = selectionSchema.safeParse(value);
          if (parsed.success) out[root] = parsed.data;
        }
        return out;
      }),
  })
  .passthrough();

export type AgentAccountStore = z.infer<typeof storeSchema>;

/** The in-memory default — what a missing file behaves like, and the zero-config state. */
export function defaultAgentAccountStore(): AgentAccountStore {
  return storeSchema.parse({});
}

/**
 * Read the store on demand — never cached, never throws.
 *
 * Not cached because `~/.cezar/` is shared by every cezar process on the machine, so a snapshot is
 * a staleness bug; one small JSON read is free next to spawning a CLI.
 *
 * A missing file is the zero-config default (silent). A corrupt one degrades to the default with a
 * one-line warning and is left on disk untouched, so the user can repair it by hand — the next
 * successful merge-write is what replaces it.
 */
export async function loadAgentAccounts(): Promise<AgentAccountStore> {
  const path = agentAccountsPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Absent — but accounts may predate this file (they lived in config.json on the branch that
    // introduced them), so give those one chance to come across.
    return importLegacyAccounts();
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to the warning + defaults
  }
  console.warn(`[cez] agent accounts ${path} is corrupt — ignoring it (every project falls back to its default account)`);
  return defaultAgentAccountStore();
}

/**
 * Read-modify-write merge: re-read, apply `mutator`, atomic-rename write.
 *
 * Because every writer re-reads immediately before writing, two cezar processes editing different
 * accounts converge instead of dropping each other's — last-writer-wins only inside the tiny
 * read→rename window, which is the same bargain `config.json` makes. Throws on write failure (a
 * read-only home); degrading is the caller's policy.
 */
export async function mergeWriteAgentAccounts(
  mutator: (store: AgentAccountStore) => AgentAccountStore | void,
): Promise<AgentAccountStore> {
  const current = await loadAgentAccounts();
  const next = mutator(current) ?? current;
  atomicWriteJsonSync(agentAccountsPath(), next);
  return next;
}

/**
 * One-time, non-destructive import of accounts that were written into `config.json` by the branch
 * that first introduced them (before they got their own file).
 *
 * Reads the RAW object rather than going through the workspace schema, because that schema no
 * longer names these keys — they only survive there as passthrough. Nothing is deleted from
 * `config.json`: an older cezar sharing this home keeps reading what it has always read, and this
 * import is idempotent because it only runs while `agent-accounts.json` is absent.
 */
async function importLegacyAccounts(): Promise<AgentAccountStore> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(workspaceConfigPath(), 'utf8'));
  } catch {
    return defaultAgentAccountStore();
  }
  if (!parsed || typeof parsed !== 'object') return defaultAgentAccountStore();
  const legacy = parsed as { agentProfiles?: unknown; projects?: unknown };
  const selections: Record<string, unknown> = {};
  if (Array.isArray(legacy.projects)) {
    for (const entry of legacy.projects) {
      if (!entry || typeof entry !== 'object') continue;
      const { root, agentProfile } = entry as { root?: unknown; agentProfile?: unknown };
      if (typeof root === 'string' && agentProfile && typeof agentProfile === 'object') {
        selections[root] = agentProfile;
      }
    }
  }
  const imported = storeSchema.safeParse({ accounts: legacy.agentProfiles, selections });
  if (!imported.success) return defaultAgentAccountStore();
  // Only worth persisting when there was something to carry over; an empty import must not create
  // a file, or the zero-config promise ("delete any of them and cezar rebuilds") gains a file that
  // exists for no reason.
  if (imported.data.accounts.length === 0) return imported.data;
  try {
    atomicWriteJsonSync(agentAccountsPath(), imported.data);
  } catch {
    // read-only home: the import stays in memory for this process, which is still correct
  }
  return imported.data;
}

/**
 * The account `provider` uses for `repoRoot`, or undefined when nothing has an opinion.
 *
 * Repo first, then the machine-wide default. The order is the whole feature: a repo that chose is
 * never overruled by a later change to the default, and a repo that never chose follows it — so
 * adding a second login is a one-time act rather than one per checkout.
 */
export function selectionFor(
  store: Pick<AgentAccountStore, 'selections' | 'defaults'>,
  repoRoot: string | undefined,
  provider: ProviderId,
): string | undefined {
  const chosen = repoRoot === undefined ? undefined : selectionForRoot(store, repoRoot)?.[provider];
  return chosen ?? store.defaults[provider];
}

/**
 * The selection stored for `repoRoot`, matched on the literal spelling first and the realpath'd
 * one second.
 *
 * The keys come from the REGISTRY, which realpath-normalizes every root it stores
 * (`workspace/projects.ts` `normalizeRoot`); the readers hold whatever spelling their caller had —
 * `RunManager` is constructed with `repoInfo?.root ?? cwd` for the boot project, not with the
 * registry entry. `workspace/semaphore.ts` already normalizes at lookup for the per-project
 * concurrency map for exactly this reason. Doing it here too matters more, not less: a missed
 * concurrency override runs the task with the wrong ceiling, a missed account selection runs it on
 * the wrong subscription and says nothing.
 *
 * The literal probe comes first because it is free and answers the overwhelmingly common case; the
 * normalized one only pays a `realpathSync` when the literal key is absent.
 */
function selectionForRoot(
  store: Pick<AgentAccountStore, 'selections'>,
  repoRoot: string,
): AgentAccountSelection | undefined {
  const literal = store.selections[repoRoot];
  if (literal !== undefined) return literal;
  const normalized = normalizeRootSync(repoRoot);
  return normalized === repoRoot ? undefined : store.selections[normalized];
}

/** Realpath-normalize a root the way the registry does, but synchronously — this answers a run's
 *  per-step lookup and must not `await`. A path that cannot be realpath'd (gone, unreadable)
 *  degrades to `resolve()`, matching the registry's own fallback and `semaphore.ts`'s. */
function normalizeRootSync(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}
