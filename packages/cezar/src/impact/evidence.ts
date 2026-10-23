/**
 * `cez impact evidence` — commit-pinned Git evidence for an impact review; the port of
 * `pr-impact`'s `collect_evidence.py` (spec 2026-10-22-html-artifacts-and-impact, Q7), plus spec
 * mode and `public_surface_candidates` (R3).
 *
 * Read-only by construction: it never fetches, checks out or runs project code. The run's
 * worktree already holds the PR head (Q8); a commit that is missing locally is reported, not
 * fetched. Never throws — every failure comes back as `{ ok: false, error }`, and the error never
 * echoes raw stderr (it can carry remote URLs or auth hints).
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

export interface CommandResult {
  ok: boolean;
  stdout: Buffer;
  code: number | null;
}

/** The one process seam: tests swap `gh` for a fake and keep real `git`. */
export type CommandRunner = (cmd: 'git' | 'gh', args: string[], cwd: string) => Promise<CommandResult>;

export const runCommand: CommandRunner = (cmd, args, cwd) =>
  new Promise((done) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        encoding: 'buffer',
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GH_PROMPT_DISABLED: '1' },
      },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        done({ ok: !error, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''), code });
      },
    );
  });

export type EvidenceRequest =
  | { mode: 'range'; base: string; head: string }
  | { mode: 'pr'; pr: string }
  | { mode: 'spec'; path: string };

export interface PublicSurfaceCandidate {
  path: string;
  status?: string;
  ecosystem: string;
  surface: string;
  reason: string;
}

export interface ImpactEvidence {
  mode: EvidenceRequest['mode'];
  comparison: { base: string; head: string; merge_base: string; semantics: string };
  pr: Record<string, unknown>;
  spec?: { path: string; blob_sha: string; text: string; text_truncated: boolean; cited_paths: string[]; cited_paths_truncated: boolean };
  changed_files: { status: string; path: string }[];
  public_surface_candidates: PublicSurfaceCandidate[];
  context_candidates: string[];
  context_candidates_truncated: boolean;
  worktree_dirty: boolean;
  limitations: string[];
}

export type EvidenceResult = { ok: true; evidence: ImpactEvidence } | { ok: false; error: string };

const CONTEXT_LIMIT = 100;
const CITED_LIMIT = 200;
const SPEC_TEXT_LIMIT = 200_000;

const CONTEXT_PATTERN = /(^|\/)(AGENTS\.md|README[^/]*|CODEOWNERS|.*[Aa][Dd][Rr].*|.*[Aa]rchitecture.*|.*[Rr]oadmap.*|.*[Pp]roduct.*)$/;

/** Where public surfaces live, per ecosystem (references/public-api.md). A starting point for the
 *  agent's own diff of the surface, never proof that something changed for a consumer. */
const SURFACE_PATTERNS: { re: RegExp; ecosystem: string; surface: string; reason: string }[] = [
  { re: /(^|\/)package\.json$/, ecosystem: 'js', surface: 'export', reason: 'package manifest (exports, bin, engines)' },
  { re: /(^|\/)index\.(ts|tsx|mts|js|mjs|cjs)$/, ecosystem: 'js', surface: 'export', reason: 'package entry / re-export barrel' },
  { re: /\.d\.(ts|mts|cts)$/, ecosystem: 'js', surface: 'export', reason: 'type declarations' },
  { re: /(^|\/)packages\/contract\//, ecosystem: 'cezar', surface: 'http', reason: 'cezar HTTP contract (zod schemas)' },
  { re: /(^|\/)[^/]*(openapi|swagger)[^/]*\.(ya?ml|json)$/i, ecosystem: 'http', surface: 'http', reason: 'OpenAPI document' },
  { re: /\.(graphql|gql|proto)$/, ecosystem: 'http', surface: 'schema', reason: 'GraphQL / protobuf schema' },
  { re: /(^|\/)(StoreApi|SalesChannel)\/.*\.php$/, ecosystem: 'shopware', surface: 'http', reason: 'Store API route' },
  { re: /(^|\/)(AdminApi|Api)\/.*\.php$/, ecosystem: 'shopware', surface: 'http', reason: 'Admin API route' },
  { re: /Controller\.php$/, ecosystem: 'php', surface: 'http', reason: 'controller (route attributes)' },
  { re: /Event\.php$/, ecosystem: 'php', surface: 'event', reason: 'event class' },
  { re: /Subscriber\.php$/, ecosystem: 'php', surface: 'event', reason: 'event subscriber' },
  { re: /(^|\/)services\.(xml|ya?ml|php)$/, ecosystem: 'php', surface: 'extension-point', reason: 'DI services (decorators, tags)' },
  { re: /Definition\.php$/, ecosystem: 'shopware', surface: 'schema', reason: 'entity definition (fields)' },
  { re: /(^|\/)Migration[^/]*\.php$/, ecosystem: 'php', surface: 'schema', reason: 'database migration' },
  { re: /(^|\/)Resources\/app\/administration\/.*\.twig$/, ecosystem: 'shopware', surface: 'extension-point', reason: 'administration Twig blocks' },
  { re: /(^|\/)Resources\/views\/.*\.twig$/, ecosystem: 'shopware', surface: 'extension-point', reason: 'storefront Twig blocks' },
  { re: /(^|\/)(composer\.json|plugin\.xml)$/, ecosystem: 'php', surface: 'export', reason: 'package manifest' },
  { re: /(^|\/)(bin|cli|commands?)\/[^/]+$/i, ecosystem: 'generic', surface: 'cli', reason: 'CLI entry / commands' },
  { re: /Command\.(php|ts|js)$/, ecosystem: 'generic', surface: 'cli', reason: 'CLI command' },
  { re: /(^|\/)\.env(\.[\w-]+)?\.(example|dist|sample)$|(^|\/)\.env\.example$/, ecosystem: 'generic', surface: 'config', reason: 'documented environment variables' },
  { re: /(\.schema\.json|(^|\/)config\.schema\.[\w]+)$/, ecosystem: 'generic', surface: 'config', reason: 'config schema' },
  { re: /(^|\/)(db\/)?migrations?\/[^/]+$/i, ecosystem: 'generic', surface: 'schema', reason: 'database migration' },
];

export function publicSurfaceCandidates(files: readonly { path: string; status?: string }[]): PublicSurfaceCandidate[] {
  const out: PublicSurfaceCandidate[] = [];
  for (const file of files) {
    const hit = SURFACE_PATTERNS.find((p) => p.re.test(file.path));
    if (hit) out.push({ path: file.path, ...(file.status ? { status: file.status } : {}), ecosystem: hit.ecosystem, surface: hit.surface, reason: hit.reason });
  }
  return out;
}

/** Repo paths a spec cites (backticked or linked), kept only when they exist at HEAD. */
export function citedPaths(text: string, tracked: ReadonlySet<string>): string[] {
  const dirs = new Set<string>();
  for (const file of tracked) {
    let at = file.lastIndexOf('/');
    while (at > 0) {
      dirs.add(file.slice(0, at));
      at = file.lastIndexOf('/', at - 1);
    }
  }
  const found = new Set<string>();
  const tokens = [...text.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? m[2] ?? '');
  for (const token of tokens) {
    for (const raw of token.split(/\s+/)) {
      const path = raw.replace(/^\.?\//, '').replace(/[),.;]+$/, '').replace(/:\d+(?:-\d+)?(?:,\d+)*$/, '').replace(/\/$/, '');
      if (path && (tracked.has(path) || dirs.has(path))) found.add(path);
    }
  }
  return [...found];
}

const ghRepoSchema = z.object({ nameWithOwner: z.string() });
const ghPrSchema = z.object({
  number: z.number().int().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  url: z.string().optional(),
  baseRefName: z.string().optional(),
  headRefName: z.string().optional(),
  baseRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
});

class EvidenceError extends Error {}

export async function collectEvidence(
  repo: string,
  request: EvidenceRequest,
  run: CommandRunner = runCommand,
): Promise<EvidenceResult> {
  try {
    return { ok: true, evidence: await collect(repo, request, run) };
  } catch (error) {
    return { ok: false, error: error instanceof EvidenceError ? error.message : `evidence collection failed: ${String(error)}` };
  }
}

async function collect(repo: string, request: EvidenceRequest, run: CommandRunner): Promise<ImpactEvidence> {
  const command = async (cmd: 'git' | 'gh', args: string[], cwd: string): Promise<Buffer> => {
    const result = await run(cmd, args, cwd);
    // Do not echo remote URLs or auth-related stderr into an artifact (collect_evidence.py).
    if (!result.ok) throw new EvidenceError(`${cmd} ${args[0]} failed (exit ${result.code ?? '?'}); verify the checkout, refs and configured access`);
    return result.stdout;
  };
  const top = (await command('git', ['rev-parse', '--show-toplevel'], resolve(repo))).toString('utf8').trim();
  const git = (...args: string[]) => command('git', args, top);
  const sha = async (ref: string) => {
    if (!ref || ref.startsWith('-')) throw new EvidenceError('Invalid commit reference');
    const out = await run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], top);
    if (!out.ok) throw new EvidenceError(`commit ${ref} is not available locally; it is never fetched here — ask before fetching it`);
    return out.stdout.toString('utf8').trim();
  };

  let pr: Record<string, unknown> = {};
  let base: string;
  let head: string;
  let spec: ImpactEvidence['spec'];
  if (request.mode === 'pr') {
    const url = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(request.pr);
    if (!url && !/^[1-9][0-9]*$/.test(request.pr)) throw new EvidenceError('--pr expects a PR number or a github.com PR URL');
    if (url) {
      const current = ghRepoSchema.safeParse(parseJson(await command('gh', ['repo', 'view', '--json', 'nameWithOwner'], top)));
      if (!current.success) throw new EvidenceError('gh repo view returned an unexpected shape');
      if (current.data.nameWithOwner.toLowerCase() !== `${url[1]}/${url[2]}`.toLowerCase()) {
        throw new EvidenceError('PR repository does not match checkout');
      }
    }
    const parsed = ghPrSchema.safeParse(
      parseJson(await command('gh', ['pr', 'view', request.pr, '--json', 'number,title,body,url,baseRefName,headRefName,baseRefOid,headRefOid'], top)),
    );
    if (!parsed.success) throw new EvidenceError('gh pr view returned an unexpected shape');
    pr = parsed.data;
    base = parsed.data.baseRefOid;
    head = parsed.data.headRefOid;
  } else if (request.mode === 'range') {
    base = request.base;
    head = request.head;
  } else {
    base = head = 'HEAD';
  }
  base = await sha(base);
  head = await sha(head);

  let changed: { status: string; path: string }[] = [];
  let mergeBase = head;
  if (request.mode !== 'spec') {
    mergeBase = (await git('merge-base', base, head)).toString('utf8').trim();
    const raw = (await git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', mergeBase, head, '--'))
      .toString('utf8')
      .split('\0');
    for (let i = 0; i + 1 < raw.length; i += 2) changed.push({ status: raw[i]!, path: raw[i + 1]! });
  }

  const tracked = (await git('ls-tree', '-r', '--name-only', '-z', head)).toString('utf8').split('\0').filter(Boolean);
  if (request.mode === 'spec') {
    // Relative to where the command runs; realpaths so /tmp vs /private/tmp cannot fake an escape.
    const abs = isAbsolute(request.path) ? request.path : resolve(realpathOr(resolve(repo)), request.path);
    const rel = relative(realpathOr(top), realpathOr(abs)).split('\\').join('/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new EvidenceError('--spec must name a file inside the repository');
    const blob = await run('git', ['rev-parse', '--verify', '--quiet', `${head}:${rel}`], top);
    if (!blob.ok) throw new EvidenceError(`spec ${rel} is not committed at HEAD; commit it first so the assessment pins a blob`);
    const text = (await git('cat-file', 'blob', blob.stdout.toString('utf8').trim())).toString('utf8');
    const cited = citedPaths(text, new Set(tracked)).filter((p) => p !== rel);
    spec = {
      path: rel,
      blob_sha: blob.stdout.toString('utf8').trim(),
      text: text.slice(0, SPEC_TEXT_LIMIT),
      text_truncated: text.length > SPEC_TEXT_LIMIT,
      cited_paths: cited.slice(0, CITED_LIMIT),
      cited_paths_truncated: cited.length > CITED_LIMIT,
    };
    changed = [];
  }

  const context = tracked.filter((p) => CONTEXT_PATTERN.test(p));
  const surfaces = publicSurfaceCandidates(spec ? spec.cited_paths.map((path) => ({ path })) : changed);
  const dirty = (await git('status', '--porcelain', '-z')).length > 0;
  const limitations = [
    'No source files or tests were executed; uncommitted changes excluded.',
    'Renames represented as deletion plus addition. Agent must inspect source at both commits.',
    'Context candidates are paths, not verified product/architecture evidence.',
    'Git metadata does not establish runtime behavior, product fit or merge readiness.',
    'Public surface candidates are path matches, not proof that a consumer-visible contract changed.',
  ];
  if (spec) {
    limitations.push('Spec mode: nothing is built yet. Everything the spec proposes is inferred; only today\'s code can be observed.');
  }
  return {
    mode: request.mode,
    comparison: {
      base,
      head,
      merge_base: mergeBase,
      semantics: request.mode === 'spec' ? 'spec-at-head' : 'merge-base..head',
    },
    pr,
    ...(spec ? { spec } : {}),
    changed_files: changed,
    public_surface_candidates: surfaces,
    context_candidates: context.slice(0, CONTEXT_LIMIT),
    context_candidates_truncated: context.length > CONTEXT_LIMIT,
    worktree_dirty: dirty,
    limitations,
  };
}

function parseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
