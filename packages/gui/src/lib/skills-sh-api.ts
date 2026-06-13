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

function apiBase(): string {
  return process.env.SKILLS_SH_API_BASE || DEFAULT_API_BASE;
}

export interface SkillsShSkill {
  /** API-supplied display name; may differ from the slug's last segment. */
  name: string;
  description: string | null;
  /** Body of the chosen markdown file — empty string if no `.md` file shipped. */
  body: string;
  /** API snapshot fingerprint; we store it so Refresh can short-circuit. */
  contentHash: string | null;
  /** Public skills.sh URL for the skill. */
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

export async function fetchSkillsShSkill(slug: string): Promise<SkillsShSkill> {
  const token = process.env.SKILLS_SH_TOKEN;
  if (!token) throw new SkillsShNotConfiguredError();
  if (!slug.trim()) throw new SkillsShNotFoundError(slug);

  const url = `${apiBase()}/api/v1/skills/${encodeSlug(slug)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  if (res.status === 401 || res.status === 403) throw new SkillsShAuthError();
  if (res.status === 404) throw new SkillsShNotFoundError(slug);
  if (!res.ok) {
    const tail = await res.text().catch(() => '');
    throw new Error(`skills.sh fetch ${res.status}${tail ? `: ${tail.slice(0, 200)}` : ''}`);
  }

  const data = (await res.json()) as ApiSkillResponse;
  const files = parseFiles(data.files);
  return {
    name:
      typeof data.name === 'string' && data.name.trim()
        ? data.name.trim()
        : slug.split('/').pop() ?? slug,
    description: typeof data.description === 'string' ? data.description : null,
    body: pickBody(files),
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
    installUrl: typeof data.installUrl === 'string' ? data.installUrl : null,
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
  return candidate;
}

/** URL-encodes each path segment without touching the `/` separators. */
function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/');
}

export function isSkillsShConfigured(): boolean {
  return Boolean(process.env.SKILLS_SH_TOKEN);
}
