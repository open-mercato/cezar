/**
 * Issue #262 (PR 4) — thin HTTP client for the skills.sh API.
 *
 * Docs: https://skills.sh/docs/api
 *   GET /api/v1/skills/{source}/{slug} → { name, description, files[], contentHash, installUrl, … }
 *
 * Auth is required: `Authorization: Bearer <token>` (Vercel OIDC or a
 * long-lived API key). Without `SKILLS_SH_TOKEN` set we throw early so the
 * caller can surface a clear "configure SKILLS_SH_TOKEN" error instead of
 * leaking a generic 401.
 *
 * Body lives in `files[].contents`. Skills.sh docs don't pin a canonical
 * filename for the main markdown, so we prefer `SKILL.md` (a documented
 * convention) and fall back to the first `*.md` entry.
 */

const DEFAULT_API_BASE = 'https://skills.sh';
const FETCH_TIMEOUT_MS = 15_000;
/**
 * Upper bound on the raw response payload we'll buffer from the registry.
 * Keep modestly above the per-skill body cap (skills-sh-actions:MAX_BODY_BYTES)
 * so headers/metadata fit while still bounding the OOM blast radius for a
 * compromised or misconfigured upstream.
 */
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

/**
 * Validate the API base at resolve-time so a misconfigured env (typo'd
 * `http://`, internal/loopback hostnames pointing at cloud metadata, etc.)
 * surfaces a clear error instead of silently downgrading TLS or exfiltrating
 * the bearer token.
 */
function apiBase(): string {
  const raw = process.env.SKILLS_SH_API_BASE || DEFAULT_API_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SKILLS_SH_API_BASE is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`SKILLS_SH_API_BASE must use https:// (got ${url.protocol})`);
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error(`SKILLS_SH_API_BASE points at a private/loopback address: ${url.hostname}`);
  }
  // Strip any trailing slash so the request URL stays predictable.
  return raw.replace(/\/+$/, '');
}

/**
 * Reject loopback (127/8, ::1, localhost), link-local (169.254/16) and
 * RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16) hostnames. Doesn't
 * defend against DNS-rebinding — that needs explicit IP-pinning, out of
 * scope for an admin-controlled env var.
 */
function isPrivateHostname(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export interface SkillsShSkill {
  /** API-supplied display name; may differ from the slug's last segment. */
  name: string;
  description: string | null;
  /** Body of the chosen markdown file — empty string if no `.md` file shipped. */
  body: string;
  /** API snapshot fingerprint; we store it so Refresh can short-circuit. */
  contentHash: string | null;
  /** Public skills.sh URL for the skill — `https:` only; non-https payloads are dropped. */
  installUrl: string | null;
}

export class SkillsShAuthError extends Error {
  constructor(message = 'skills.sh rejected the token (401/403)') {
    super(message);
    this.name = 'SkillsShAuthError';
  }
}

export class SkillsShNotFoundError extends Error {
  constructor(slug: string) {
    super(`skills.sh skill not found: ${slug}`);
    this.name = 'SkillsShNotFoundError';
  }
}

export class SkillsShNotConfiguredError extends Error {
  constructor() {
    super('SKILLS_SH_TOKEN is not set — skills.sh integration is disabled');
    this.name = 'SkillsShNotConfiguredError';
  }
}

export class SkillsShTimeoutError extends Error {
  constructor() {
    super(`skills.sh request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    this.name = 'SkillsShTimeoutError';
  }
}

export class SkillsShPayloadTooLargeError extends Error {
  constructor() {
    super(`skills.sh response exceeded ${MAX_RESPONSE_BYTES / 1024}KB cap`);
    this.name = 'SkillsShPayloadTooLargeError';
  }
}

interface ApiFile {
  path: string;
  contents: string;
}

interface ApiSkillResponse {
  name?: unknown;
  description?: unknown;
  contentHash?: unknown;
  installUrl?: unknown;
  files?: unknown;
}

function pickBody(files: ApiFile[]): string {
  const skillFile =
    files.find((f) => /(^|\/)skill\.md$/i.test(f.path)) ??
    files.find((f) => f.path.toLowerCase().endsWith('.md')) ??
    null;
  return skillFile?.contents ?? '';
}

function parseFiles(raw: unknown): ApiFile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ApiFile | null => {
      if (!entry || typeof entry !== 'object') return null;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.path !== 'string' || typeof obj.contents !== 'string') return null;
      return { path: obj.path, contents: obj.contents };
    })
    .filter((f): f is ApiFile => f !== null);
}

/**
 * Only persist `installUrl` when it is a plain HTTPS URL. The value is later
 * rendered as an `<a href>`, so any `javascript:` / `data:` scheme returned
 * by a compromised or misconfigured registry would become a one-click XSS
 * sink. We drop unsafe values rather than fail the whole fetch — the skill
 * itself is fine, only the convenience link is missing.
 */
function sanitizeInstallUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function fetchSkillsShSkill(slug: string): Promise<SkillsShSkill> {
  const token = process.env.SKILLS_SH_TOKEN;
  if (!token) throw new SkillsShNotConfiguredError();
  if (!slug.trim()) throw new SkillsShNotFoundError(slug);

  const url = `${apiBase()}/api/v1/skills/${encodeSlug(slug)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout(...) abort surfaces as a TimeoutError-named DOMException.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new SkillsShTimeoutError();
    }
    throw err;
  }

  if (res.status === 401 || res.status === 403) throw new SkillsShAuthError();
  if (res.status === 404) throw new SkillsShNotFoundError(slug);
  if (!res.ok) {
    const tail = await res.text().catch(() => '');
    throw new Error(`skills.sh fetch ${res.status}${tail ? `: ${tail.slice(0, 200)}` : ''}`);
  }

  // Cheap pre-flight on Content-Length so a hostile multi-GB body doesn't
  // make it past the network layer. We still rely on the JSON parser for the
  // real size — chunked responses ship without Content-Length, so this catches
  // the obvious case rather than every case.
  const declared = res.headers.get('content-length');
  if (declared && Number.parseInt(declared, 10) > MAX_RESPONSE_BYTES) {
    throw new SkillsShPayloadTooLargeError();
  }

  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new SkillsShPayloadTooLargeError();
  }
  let data: ApiSkillResponse;
  try {
    data = JSON.parse(text) as ApiSkillResponse;
  } catch {
    throw new Error('skills.sh returned non-JSON body');
  }

  const files = parseFiles(data.files);
  return {
    name:
      typeof data.name === 'string' && data.name.trim()
        ? data.name.trim()
        : (slug.split('/').pop() ?? slug),
    description: typeof data.description === 'string' ? data.description : null,
    body: pickBody(files),
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
    installUrl: sanitizeInstallUrl(data.installUrl),
  };
}

/**
 * Accepts either the bare `'source/slug'` identifier or a full
 * `https://skills.sh/<source>/<slug>` URL and returns the canonical
 * `source/slug` form. Returns null on malformed input.
 */
export function parseSkillsShIdentifier(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?skills\.sh\/(.+?)\/?$/i);
  const candidate = urlMatch ? urlMatch[1] : trimmed;
  // Allow letters, digits, dots, dashes, underscores; require at least 2 segments
  // (source/skill) and cap at 5 to stay close to the API's id format.
  if (!/^[\w.-]+(?:\/[\w.-]+){1,4}$/.test(candidate)) return null;
  // Reject path-traversal segments — `[\w.-]+` would otherwise match `.` and
  // `..`, and `encodeURIComponent` doesn't encode dots, so the literal `..`
  // survives all the way to the outbound URL where fetch / upstream
  // normalize it away and bypass the intended `{source}/{slug}` scoping.
  const segments = candidate.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return candidate;
}

/** URL-encodes each path segment without touching the `/` separators. */
function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/');
}

export function isSkillsShConfigured(): boolean {
  return Boolean(process.env.SKILLS_SH_TOKEN);
}
