/**
 * Redact credentials before they are persisted to a run's NDJSON transcript
 * (#427). Tool-result output is written verbatim to disk and served back over
 * the API, so the moment an agent runs a command whose output contains a
 * secret (`printenv`, `cat ~/.aws/credentials`, …) that secret would land in
 * `.ai/cezar/` — violating the "No secrets in state files" invariant
 * (AGENTS.md / CODE_REVIEW.md).
 *
 * Two complementary strategies:
 *   1. Value-based — the concrete values of the host's own secret-named env
 *      vars (GITHUB_TOKEN, ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, …). If
 *      any of them appears in event text, it is scrubbed.
 *   2. Pattern-based — well-known token shapes (gh*, sk-*, AKIA*, AIza*,
 *      xox*-*) so secrets that never lived in cezar's own env are still caught.
 *
 * Zero-config: redaction is on by default; `CEZ_REDACT_SECRETS=0` opts out.
 */

export const REDACTED = '[REDACTED]';

/**
 * Names that look like a credential — the single source of truth for "is this
 * var a secret?", shared with `agent-env.ts` (#427 review). The two used to
 * carry near-identical but subtly different lists, so a var could be stripped
 * from the child env yet never collected for redaction (or vice versa). One
 * constant, one answer: what we refuse to forward is exactly what we scrub.
 */
export const SECRET_NAME_RE =
  /(^CEZ_TRACKER_CAPABILITY$|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|_KEY_|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|_AUTH$|_AUTH_|SESSION|COOKIE|PASSPHRASE)/i;

/** Names matched above whose value is NOT a secret (a socket path, a pid, a
 *  desktop-session id) — collecting them would scrub ordinary paths from the
 *  transcript for no benefit. */
const SECRET_VALUE_NAME_ALLOW: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SESSION_MANAGER',
  'SESSIONNAME',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_CLASS',
  'XDG_SESSION_DESKTOP',
]);

/**
 * Below this length a "secret" value is too common a word to redact safely.
 * Verified over-redaction at the old floor of 8 (#427 review): a dev box with
 * `POSTGRES_PASSWORD=postgres` turned `apt install postgresql-16` into
 * `apt install [REDACTED]ql-16` in the transcript. Real credentials (API keys,
 * PATs, AWS secrets) are 20+ chars, so 12 keeps the catch rate while putting
 * short dictionary words — the whole source of false positives — out of reach.
 * Pattern-based redaction below is unaffected: it matches token *shapes*, not
 * env values, and still catches short-but-real tokens.
 */
export const MIN_SECRET_LEN = 12;

/** Well-known credential shapes, independent of the host env. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /whsec_[A-Za-z0-9+/=]{32,}/g, // outbound webhook signing keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / server / user / refresh
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  // A key never follows a letter or digit; `task-scheduling-…` ends in "sk-" and is a word.
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9-_]{20,}/g, // Anthropic
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9-_]{20,}/g, // OpenAI & compatible
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g, // AWS temporary access key id
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /ya29\.[0-9A-Za-z_-]+/g, // Google OAuth access token
  /xox[baprs]-[0-9A-Za-z-]{10,}/g, // Slack
  /glpat-[0-9A-Za-z_-]{20,}/g, // GitLab PAT
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collect the concrete secret values present in `env` (deduped, longest
 *  first so a value that contains another is replaced whole). */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LEN) continue;
    if (SECRET_VALUE_NAME_ALLOW.has(name.toUpperCase())) continue;
    if (SECRET_NAME_RE.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replace every known secret value / token shape in `text` with `[REDACTED]`. */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  // Match against the original text: sequential replacement loses containing
  // and crossing matches, and can even rewrite our own replacement marker.
  // Explicit values may be shorter than the environment collection floor.
  // One furthest endpoint per start, allocated only if anything matches.
  // State is O(text.length), not O(occurrences): repetitive text can contain
  // millions of overlapping matches whose union is just one span.
  let ends: Uint32Array | undefined;
  const cover = (start: number, stop: number): void => {
    ends ??= new Uint32Array(text.length);
    ends[start] = Math.max(ends[start]!, stop);
  };
  for (const value of new Set(secretValues.filter(value => value.length > 0))) {
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
      cover(start, start + value.length);
    }
  }
  // Patterns must also see the original text. Replacing a known prefix or
  // interior first can destroy the token shape and expose the remaining key.
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    for (let match = re.exec(text); match !== null; match = re.exec(text)) {
      cover(match.index, match.index + match[0].length);
    }
  }
  if (!ends) return text;
  let out = '', copied = 0;
  for (let start = 0; start < ends.length; start++) {
    let stop = ends[start]!;
    if (stop === 0) continue;
    out += text.slice(copied, start) + REDACTED;
    // Strict overlap: touching matches retain separate replacement markers.
    for (let next = start + 1; next < stop; next++) {
      stop = Math.max(stop, ends[next]!);
    }
    copied = stop;
    start = stop - 1;
  }
  out += text.slice(copied);
  return out;
}

/**
 * Deep-copy `value`, redacting every string leaf. Structure/keys are
 * preserved; only string values (and string keys are left untouched — keys are
 * event field names, never secrets) are scrubbed.
 */
export function redactDeep<T>(value: T, secretValues: readonly string[]): T {
  if (typeof value === 'string') {
    return redactSecrets(value, secretValues) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, secretValues)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, secretValues);
    }
    return out as T;
  }
  return value;
}
