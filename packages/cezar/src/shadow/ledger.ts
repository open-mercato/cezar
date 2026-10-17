import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A shadow run's on-disk state (spec `2026-10-06-shadow-runs` § Data model), under
 * `.ai/cezar/shadow/<runId>/`:
 *
 *   shadow.json        what the shim needs: run id, repo root, the real `gh`
 *   intents.ndjson     append-only; written by the shim and the shadow remotes' hooks
 *   decisions.ndjson   append-only; written by the server only (promote / discard / failed)
 *   bin/               the `gh` shim, first on the run's PATH
 *   remotes/<slug>.git the shadow remotes pushes land in
 *
 * This module is imported by the SHIM, which runs under a bare `node` inside the agent's process
 * tree - so it depends on Node builtins only: no zod, no contract package. Validation lives on the
 * server side (`ledger-store.ts`), which treats every line here as untrusted input.
 */

export const LEDGER_VERSION = 1;

/** Mirrors `SHADOW_INTENT_ID_RE` in `@open-mercato/cezar-contract`; `ledger-store.test.ts` pins the
 *  two together, because the shim cannot import the contract. */
export const INTENT_ID_RE = /^[0-9a-z]{6,12}-[0-9a-f]{6}$/;

export function shadowDir(dataDir: string, runId: string): string {
  return join(dataDir, 'shadow', runId);
}

export interface ShadowPaths {
  dir: string;
  config: string;
  intents: string;
  decisions: string;
  bin: string;
  remotes: string;
  /** Rewrite target for every push that is not to a configured remote. Never created. */
  blocked: string;
  /** Scratch bare repository the arming probe pushes from (see `verifyPushRedirect`). */
  probe: string;
}

export function shadowPaths(dir: string): ShadowPaths {
  return {
    dir,
    config: join(dir, 'shadow.json'),
    intents: join(dir, 'intents.ndjson'),
    decisions: join(dir, 'decisions.ndjson'),
    bin: join(dir, 'bin'),
    remotes: join(dir, 'remotes'),
    blocked: join(dir, 'blocked-push'),
    probe: join(dir, 'probe.git'),
  };
}

export interface ShadowConfig {
  v: typeof LEDGER_VERSION;
  runId: string;
  /** Where pushed commits are pinned (`refs/cezar/shadow/<runId>/<intentId>`). */
  repoRoot: string;
  /** Absolute path of the `gh` reads pass through to; null when gh is not installed. The SERVER
   *  never reads this field: a promotion resolves gh on its own PATH, because this file sits in a
   *  directory the agent can write. */
  realGh: string | null;
}

/**
 * Every spawn rewrites the run's state while a shim of an earlier spawn may be reading it: same
 * content is left alone, and changed content lands whole (tmp + rename), never half-written.
 */
export function writeFileAtomic(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    // absent: write it
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function writeShadowConfig(dir: string, config: ShadowConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(shadowPaths(dir).config, `${JSON.stringify(config, null, 2)}\n`);
}

export function readShadowConfig(dir: string): ShadowConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(shadowPaths(dir).config, 'utf8')) as Partial<ShadowConfig>;
    if (parsed.v !== LEDGER_VERSION || typeof parsed.runId !== 'string' || typeof parsed.repoRoot !== 'string') return null;
    return {
      v: LEDGER_VERSION,
      runId: parsed.runId,
      repoRoot: parsed.repoRoot,
      realGh: typeof parsed.realGh === 'string' ? parsed.realGh : null,
    };
  } catch {
    return null;
  }
}

/** `<base36 epoch ms>-<6 hex>`: sortable by time, unique enough for one run's ledger. */
export function newIntentId(now: Date = new Date()): string {
  return `${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** A file a `gh` write read, captured so the intent survives the agent's temp directory. */
export interface CapturedFile {
  flag: string;
  /** argv index of the token carrying the path (see `ghFileReferences`). */
  index: number;
  inline: boolean;
  /** The path as the agent wrote it, or `-` for stdin. Display only. */
  name: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface PushIntentLine {
  v: typeof LEDGER_VERSION;
  type: 'intent';
  id: string;
  at: string;
  kind: 'push';
  remote: string;
  ref: string;
  sha: string;
  oldSha: string;
  pinned: boolean;
}

export interface ForgeIntentLine {
  v: typeof LEDGER_VERSION;
  type: 'intent';
  id: string;
  at: string;
  kind: 'forge' | 'denied';
  tool: 'gh';
  argv: string[];
  cwd: string;
  files: CapturedFile[];
  /** Something in argv or a captured body looked like a secret and was redacted before it
   *  reached the disk. Such an intent is manual-only: promoting it would post `[REDACTED]`. */
  redacted?: boolean;
  /** argv exceeded MAX_ARGV_TOKENS / MAX_ARG_CHARS and was cut. Manual-only. */
  truncated?: boolean;
}

/** argv bounds, shared by the shim (which cuts to them) and the server's schema (which enforces
 *  them): a line the shim wrote must never be one the server skips, or an intent the agent was
 *  told is "recorded" would silently not exist. */
export const MAX_ARGV_TOKENS = 256;
export const MAX_ARG_CHARS = 100_000;

export type IntentLine = PushIntentLine | ForgeIntentLine;

export interface DecisionLine {
  v: typeof LEDGER_VERSION;
  type: 'decision';
  intentId: string;
  at: string;
  decision: 'promoted' | 'discarded' | 'failed';
  detail?: string;
}

/**
 * One line, one `appendFileSync`. A single small write to a file opened in append mode is not
 * interleaved with a concurrent writer's line on any platform cezar supports, which is what lets
 * two shims (an agent running `gh` in parallel tool calls) share the file without a lock.
 */
export function appendIntent(dir: string, line: IntentLine): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(shadowPaths(dir).intents, `${JSON.stringify(line)}\n`, 'utf8');
}

export function appendDecision(dir: string, line: DecisionLine): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(shadowPaths(dir).decisions, `${JSON.stringify(line)}\n`, 'utf8');
}

/** Largest file body a `gh` write may carry into the ledger. Beyond it the intent is kept but can
 *  only be run by hand - a truncated PR body promoted as if it were whole would be a quiet lie. */
export const CAPTURE_MAX_BYTES = 256 * 1024;
export const CAPTURE_MAX_FILES = 4;

export function captureContent(name: string, read: () => Buffer): Pick<CapturedFile, 'name' | 'content' | 'bytes' | 'truncated'> {
  try {
    const bytes = read();
    const truncated = bytes.length > CAPTURE_MAX_BYTES;
    return {
      name,
      content: bytes.subarray(0, CAPTURE_MAX_BYTES).toString('utf8'),
      bytes: bytes.length,
      truncated,
    };
  } catch {
    // An unreadable file is recorded as empty and truncated, which makes the intent manual-only.
    return { name, content: '', bytes: 0, truncated: true };
  }
}

/** Values of a DENIED command are withheld from the ledger: `gh secret set NAME --body <value>`
 *  must not write the secret to disk on its way to being refused. Command words and flag names
 *  stay, so the audit trail still says what was attempted. */
export function withholdValues(argv: readonly string[]): string[] {
  let positionals = 0;
  return argv.map((token) => {
    if (token.startsWith('--')) return token.split('=')[0] as string;
    // `-bs3cr3t` is `-b s3cr3t` to pflag: keep the flag, never the attached value.
    if (token.startsWith('-')) return token.length > 2 ? `${token.slice(0, 2)}<withheld>` : token;
    positionals += 1;
    return positionals <= 2 ? token : '<withheld>';
  });
}
