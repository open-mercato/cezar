import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCursorAgentBin } from '../core/cursor-agent-runner.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import { claudeStateFilePath } from '../paths.ts';

/**
 * Who an agent account is logged in AS — the "Show details" read (spec
 * `2026-07-29-agent-profiles.md`).
 *
 * This is the second place vendor knowledge lives about an agent's home, beside
 * `catalog.ts` (which config FILES exist) and `core/agent-profiles.ts` (which env var relocates
 * the home). This one knows where each agent writes its own identity. Facts verified against the
 * files on disk 2026-07-29; re-verify before changing them.
 *
 * ## Two rules that are not negotiable
 *
 * 1. **Named fields only, never pass-through.** `~/.codex/auth.json` holds `OPENAI_API_KEY`,
 *    `access_token` and `refresh_token` right beside the identity claims. Every reader below picks
 *    fields by name and builds a fresh object; nothing here spreads, forwards or stringifies a
 *    parsed vendor object, so a key the vendor adds tomorrow cannot leak through. The JWT is read
 *    for its CLAIMS and its signature is never a credential we hold onto.
 * 2. **Read on demand, answered to exactly one route.** This never joins the accounts listing,
 *    never enters `runs.json` or the NDJSON, and is never logged. `provider-auth.ts` keeps account
 *    identity out of its own boundary on purpose; this is the deliberate, opt-in exception —
 *    localHandoff-gated, and only when the user asks for it — not a widening of that rule.
 */

/** One labelled row, as the pane renders it. Deliberately not a fixed per-provider shape: what an
 *  agent knows about its own login differs, and inventing an empty "Organization" for one that has
 *  no concept of it would be a worse answer than omitting the row. */
export interface AccountIdentityField {
  label: string;
  value: string;
}

export interface AccountIdentity {
  /** False when there is nothing to show — not signed in, no file, or a file we cannot parse. */
  available: boolean;
  /** Why, in the user's terms, when `available` is false. */
  reason?: string;
  fields: AccountIdentityField[];
}

/** `.claude.json` can carry per-project history; cap the read like `readUserMcpServers` does. */
const READ_CAP = 2 * 1024 * 1024;

const NOT_SIGNED_IN = 'Not signed in on this account yet — use Connect.';
const UNREADABLE = 'Could not read this account’s details.';

/** Read a JSON file under the cap. `null` for absent, unreadable, oversized or malformed. */
async function readJsonCapped(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > READ_CAP) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A non-empty display string, or undefined — so a blank vendor value never renders as an empty row. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Push a row only when the value is really there. */
function push(fields: AccountIdentityField[], label: string, value: unknown): void {
  const shown = text(value);
  if (shown !== undefined) fields.push({ label, value: shown });
}

/**
 * Claude Code keeps its login in `.claude.json`'s `oauthAccount` — a *sibling* of `~/.claude` by
 * default, but INSIDE an overridden config dir (`claudeStateFilePath` owns that rule, and getting
 * it wrong is how one account reports another's email).
 */
async function readClaudeIdentity(configDir: string): Promise<AccountIdentity> {
  const state = await readJsonCapped(claudeStateFilePath(configDir));
  if (state === null) return { available: false, reason: NOT_SIGNED_IN, fields: [] };
  const account = state.oauthAccount;
  if (!account || typeof account !== 'object') {
    return { available: false, reason: NOT_SIGNED_IN, fields: [] };
  }
  const a = account as Record<string, unknown>;
  const fields: AccountIdentityField[] = [];
  push(fields, 'Email', a.emailAddress);
  push(fields, 'Name', a.displayName);
  push(fields, 'Organization', a.organizationName);
  push(fields, 'Role', a.organizationRole);
  // `seatTier`/`billingType` are the closest thing to a plan the file states; neither is
  // documented, so they are shown under a label that promises no more than they are.
  push(fields, 'Seat', a.seatTier);
  push(fields, 'Billing', a.billingType);
  return fields.length > 0
    ? { available: true, fields }
    : { available: false, reason: UNREADABLE, fields: [] };
}

/**
 * Codex keeps its login in `auth.json`'s `id_token` — a JWT whose payload carries the identity
 * claims. Read for its claims only: the same file holds `OPENAI_API_KEY`, `access_token` and
 * `refresh_token`, none of which this function so much as names.
 *
 * The signature is NOT verified, and that is correct here: this is a local file the user's own CLI
 * wrote, read to display who they are — not a token cezar is accepting as proof of anything.
 */
async function readCodexIdentity(configDir: string): Promise<AccountIdentity> {
  const auth = await readJsonCapped(join(configDir, 'auth.json'));
  if (auth === null) return { available: false, reason: NOT_SIGNED_IN, fields: [] };
  const tokens = auth.tokens;
  const idToken = tokens && typeof tokens === 'object'
    ? (tokens as Record<string, unknown>).id_token
    : undefined;
  const fields: AccountIdentityField[] = [];
  const claims = typeof idToken === 'string' ? decodeJwtClaims(idToken) : null;
  if (claims !== null) {
    push(fields, 'Email', claims.email);
    push(fields, 'Name', claims.name);
    const openai = claims['https://api.openai.com/auth'];
    if (openai && typeof openai === 'object') {
      push(fields, 'Plan', (openai as Record<string, unknown>).chatgpt_plan_type);
    }
  }
  // An API-key login has no id_token at all — say which kind of login this is rather than
  // reporting "not signed in" for an account that is perfectly usable.
  if (fields.length === 0 && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY !== '') {
    return { available: true, fields: [{ label: 'Login', value: 'API key' }] };
  }
  return fields.length > 0
    ? { available: true, fields }
    : { available: false, reason: NOT_SIGNED_IN, fields: [] };
}

/** A JWT's payload claims, or null when it is not a readable three-part token. */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What this account is logged in as, or an honest reason there is nothing to show.
 *
 * Never throws. OpenCode answers "unsupported": its credentials live in a SQLite DB outside the
 * config dir (see `core/agent-profiles.ts`), so there is nothing in a config folder to read — and
 * guessing from the default login would attribute one account's identity to another.
 *
 * Cursor stores tokens outside a readable JSON identity file (often the OS keychain), so its
 * details come from `agent status` / `agent about` JSON — same named-fields-only rule, never a
 * pass-through of the CLI payload.
 */
export async function readAccountIdentity(
  provider: ProviderId,
  configDir: string,
  opts: { runCommand?: RunCursorIdentityCommand } = {},
): Promise<AccountIdentity> {
  if (provider === 'claude') return readClaudeIdentity(configDir);
  if (provider === 'codex') return readCodexIdentity(configDir);
  if (provider === 'cursor') return readCursorIdentity(configDir, opts.runCommand);
  return {
    available: false,
    reason: 'OpenCode keeps its login outside its config folder, so cezar cannot read it.',
    fields: [],
  };
}

export type RunCursorIdentityCommand = (
  args: readonly string[],
  env: Record<string, string>,
) => Promise<{ stdout: string; stderr: string; exitCode: number | null; errorCode?: string }>;

async function defaultRunCursorCommand(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; errorCode?: string }> {
  const executable = resolveCursorAgentBin();
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 256 * 1024,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        const commandError = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
        const code = commandError?.code;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: typeof code === 'number' ? code : error ? null : 0,
          errorCode: typeof code === 'string' ? code : undefined,
        });
      },
    );
  });
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Cursor Agent CLI — `agent status --format json` + `agent about --format json`.
 *
 * Verified against CLI 2026.08: status carries `userInfo.{email,firstName,lastName}`; about
 * carries `subscriptionTier` / `userEmail`. No Organization / Role fields in either payload.
 */
async function readCursorIdentity(
  configDir: string,
  runCommand: RunCursorIdentityCommand = defaultRunCursorCommand,
): Promise<AccountIdentity> {
  const env = { CURSOR_CONFIG_DIR: configDir };
  const statusResult = await runCommand(['status', '--format', 'json'], env);
  if (statusResult.errorCode === 'ENOENT') {
    return {
      available: false,
      reason: 'Cursor Agent CLI (`agent`) is not installed on this machine.',
      fields: [],
    };
  }

  const status = parseJsonObject(statusResult.stdout);
  const fields: AccountIdentityField[] = [];
  const userInfo = status?.userInfo;
  if (userInfo && typeof userInfo === 'object') {
    const u = userInfo as Record<string, unknown>;
    push(fields, 'Email', u.email);
    const name = [text(u.firstName), text(u.lastName)].filter(Boolean).join(' ');
    if (name) fields.push({ label: 'Name', value: name });
  } else {
    push(fields, 'Email', status?.userEmail);
  }

  const aboutResult = await runCommand(['about', '--format', 'json'], env);
  const about = parseJsonObject(aboutResult.stdout);
  if (about) {
    push(fields, 'Plan', about.subscriptionTier);
    if (fields.every((f) => f.label !== 'Email')) push(fields, 'Email', about.userEmail);
  }

  // An explicit unauthenticated status takes precedence over `about` supplying display fields
  // (e.g. a stale cached email) — only the documented CURSOR_API_KEY fallback below may still
  // report a login in that case.
  const explicitlyUnauthenticated = status?.isAuthenticated === false || status?.status === 'unauthenticated';
  const authenticated = !explicitlyUnauthenticated
    && (status?.isAuthenticated === true
      || status?.status === 'authenticated'
      || fields.some((f) => f.label === 'Email'));
  if (!authenticated && process.env.CURSOR_API_KEY?.trim()) {
    return { available: true, fields: [{ label: 'Login', value: 'API key (CURSOR_API_KEY)' }] };
  }
  if (!authenticated) {
    return { available: false, reason: NOT_SIGNED_IN, fields: [] };
  }
  return { available: true, fields };
}
