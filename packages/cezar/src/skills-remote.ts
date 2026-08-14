import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConfig, type SkillsRepoSource } from './config.ts';
import { parseFrontmatter, type Skill } from './skills.ts';

/**
 * Team skills from remote git repos (spec 005), janitor-style: a bare clone
 * without a checkout, listed with `git ls-tree` and read with `git show`.
 * The cache lives in `~/.cache/cez/skills/<owner>__<name>/` — global, so one
 * fetch serves every project. Everything degrades: no network / no access to
 * the skills repo means the team skills quietly disappear from the list while
 * local skills keep working. Nothing here ever blocks startup.
 */

const LIST_TIMEOUT_MS = 10_000; // ls-tree / show / rev-parse
const CLONE_TIMEOUT_MS = 60_000; // clone / fetch

// ---- git plumbing ------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Hardening applied to *every* git invocation here (#428). The `repo`/`ref`
 * strings ultimately come from a file — `.ai/cezar/config.json` — that an
 * attacker might influence (a prompt-injected Write-only agent, a synced
 * config), so git must never be able to pick a remote-helper transport:
 *  - `protocol.ext.allow=never` / `fd.allow=never` kill the `ext::`/`fd::`
 *    helpers — the arbitrary-command-execution vector (`ext::sh -c …`).
 *  - `GIT_ALLOW_PROTOCOL` allowlists only real transports; anything else
 *    (including `ext`) is refused even if a value slips past validation.
 *  - `protocol.file.allow=user` keeps direct local-path clones (a documented
 *    source shape) working while blocking submodule/recursive file abuse.
 *  - `GIT_TERMINAL_PROMPT=0` stops git blocking on a credential prompt — this
 *    runs on cockpit open and must never hang the boot.
 */
const GIT_HARDENING_ARGS = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.fd.allow=never',
  '-c',
  'protocol.file.allow=user',
];
const GIT_HARDENING_ENV = {
  GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file',
  GIT_TERMINAL_PROMPT: '0',
};

function git(args: string[], timeoutMs: number, cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_HARDENING_ARGS, ...args],
      {
        cwd,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_HARDENING_ENV },
      },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

const ALLOWED_URL_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'file']);

/**
 * The git remote for a configured source, or null when the value is unsafe to
 * hand to `git` (#428). Team-skill repos are code-trusted — their skill bodies
 * become agent system prompts — but the *string* is attacker-influenceable, so
 * it must never be able to select a transport helper or pose as a git option.
 * We accept exactly:
 *  - `owner/name`         GitHub shorthand → canonical https
 *  - `https://` `http://` web URLs
 *  - `ssh://…` or scp-like `git@host:path`
 *  - a local path (`/abs`, `./`, `../`, `~/…`, `C:\…`) or `file://…`
 * and reject the RCE/argument-injection surface: a leading `-`, the `::`
 * remote-helper syntax (`ext::sh -c …`, `fd::…`), and any other URL scheme.
 *
 * Every reject here maps to a real vector. Shapes that are merely *unusual* —
 * a Windows drive path, `~/…` — stay accepted: `BACKWARD_COMPATIBILITY.md` §5
 * protects the `skillsRepos` source shape, so narrowing it is a breaking change
 * and needs a migration path, not a silent refusal.
 */
export function safeRemoteFor(repo: string): string | null {
  const value = repo.trim();
  if (!value) return null;
  // git would read a leading `-` as an option, not a repo — argument injection.
  if (value.startsWith('-')) return null;
  // `ext::`, `fd::`, and friends: remote-helper transports = command execution.
  if (value.includes('::')) return null;
  // Local paths are matched before the `owner/name` shorthand: `.` and `-` are
  // in the shorthand charset, so `./rel` would otherwise be read as the GitHub
  // repo `./rel` and rewritten to `https://github.com/./rel.git`.
  //
  // `~/…` — git runs via execFile with no shell, so expand it here or git would
  // look for a directory literally named `~`.
  if (/^~\//.test(value)) return join(homedir(), value.slice(2));
  if (/^(\/|\.\/|\.\.\/)/.test(value)) return value;
  // Windows drive-letter path (`C:\repo`, `C:/repo`). Not a transport — no
  // scheme, and a leading `-` is already refused above — and win32 is a
  // supported platform, so this shape must keep working (BC §5, local path).
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  // GitHub shorthand → the canonical https remote.
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}.git`;
  // Explicit URL scheme: allowlist safe transports only (blocks `ext:` etc.).
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) {
    return ALLOWED_URL_SCHEMES.has(scheme[1]!.toLowerCase()) ? value : null;
  }
  // scp-like `user@host:path` (no scheme, host before the first colon).
  if (/^[\w.-]+@[\w.-]+:/.test(value)) return value;
  return null;
}

/**
 * A ref safe to pass to `git` as a positional revision (#428): a branch, tag,
 * or commit SHA. Rejects a leading `-` (argument injection against git's option
 * surface), range/pathspec metacharacters, and anything outside the git
 * ref-name charset — so `${ref}:${path}` in `git show` can never be a `-`-flag.
 */
export function isSafeRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 256 &&
    !ref.startsWith('-') &&
    !ref.includes('..') &&
    /^[A-Za-z0-9._/-]+$/.test(ref)
  );
}

/** A full commit SHA (sha-1 or sha-256) — a pinned, immutable ref (#428). */
export function isPinnedSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref) || /^[0-9a-f]{64}$/i.test(ref);
}

/** Stable cache directory name: the last two path segments, `owner__name`. */
export function bareDirFor(repo: string): string {
  const trimmed = repo
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^~\//, '');
  const segments = trimmed.split(/[/:]/).filter(Boolean).map(sanitizeSegment);
  const key = segments.slice(-2).join('__') || 'skills';
  return join(homedir(), '.cache', 'cez', 'skills', key);
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^\w.-]/g, '-');
}

/** One warning per bad source per process — this runs on every cockpit open. */
const warnedUnsafeRemotes = new Set<string>();

function warnUnsafeRemoteOnce(repo: string): void {
  if (warnedUnsafeRemotes.has(repo)) return;
  warnedUnsafeRemotes.add(repo);
  console.warn(
    `[cez] ignoring skills repo ${JSON.stringify(repo)} — not an accepted source shape ` +
      `(owner/name, an https/http/ssh/git URL, git@host:path, or a local/file:// path). ` +
      `Check "skillsRepos" in .ai/cezar/config.json.`,
  );
}

/** Clone the skills repo bare (no checkout) into the global cache, once. */
export async function ensureBareClone(repo: string): Promise<{ bareDir: string; created: boolean }> {
  // Validate before anything else, cache hit or not: "this source is refusable"
  // should never depend on whether a clone happens to exist already.
  const remote = safeRemoteFor(repo);
  if (!remote) {
    // Everything else in this module degrades silently (offline, no access —
    // all expected). A refusal is different: it means the config is wrong or
    // tampered with, and the operator otherwise just sees skills disappear.
    warnUnsafeRemoteOnce(repo);
    throw new Error(`refusing unsafe skills repo remote: ${repo}`);
  }
  const bareDir = bareDirFor(repo);
  if (existsSync(join(bareDir, 'HEAD'))) return { bareDir, created: false };
  await mkdir(dirname(bareDir), { recursive: true });
  // `--` separates options from the remote/dir operands: even a value that
  // slipped past validation can't pose as a git option.
  const res = await git(['clone', '--bare', '--', remote, bareDir], CLONE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`git clone --bare ${remote} failed: ${res.stderr.trim()}`);
  return { bareDir, created: true };
}

/** "Refresh" — update every branch head in the bare clone from origin. */
export async function fetchAll(bareDir: string): Promise<void> {
  const res = await git(
    ['fetch', 'origin', '--prune', '+refs/heads/*:refs/heads/*'],
    CLONE_TIMEOUT_MS,
    bareDir,
  );
  if (!res.ok) throw new Error(`git fetch failed: ${res.stderr.trim() || res.stdout.trim()}`);
}

/**
 * Resolve a source ref to the immutable commit SHA it names, or null (#428).
 * An unsafe ref is refused outright. A ref pinned to a full commit SHA is
 * verified to name exactly that commit and is *never* replaced by a moving
 * `HEAD` fallback — that is the whole point of pinning against a force-push /
 * supply-chain swap. A branch/tag falls back through the usual candidates.
 *
 * Always returning a SHA (never the mutable name) means one listing reads every
 * skill at a single commit: a concurrent `refreshTeamSkills` can move the branch
 * head mid-read without the list and the bodies drifting apart.
 */
async function resolveRef(bareDir: string, ref: string): Promise<string | null> {
  if (!isSafeRef(ref)) return null;
  if (isPinnedSha(ref)) {
    const sha = ref.toLowerCase();
    const probe = await git(
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      LIST_TIMEOUT_MS,
      bareDir,
    );
    // Pinned means pinned: only accept when rev-parse names exactly this commit.
    return probe.ok && probe.stdout.trim() === sha ? sha : null;
  }
  for (const candidate of [ref, `refs/heads/${ref}`, 'HEAD']) {
    const probe = await git(
      ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
      LIST_TIMEOUT_MS,
      bareDir,
    );
    if (probe.ok && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}

// ---- skill discovery (three conventions) --------------------------------------

interface SkillPathHit {
  /** null → the name comes from the file's frontmatter (markdown convention). */
  name: string | null;
  kind: 'skill' | 'command' | 'markdown';
}

/**
 * Match the janitor conventions plus our own:
 *  - `**\/SKILL.md`          → skill named after the parent directory (with references/)
 *  - `**\/commands/<n>.md`   → skill `<n>`
 *  - `.ai/skills/**\/*.md` or `.ai/cezar/skills/**\/*.md` → frontmatter/basename name
 */
function matchSkillPath(line: string): SkillPathHit | null {
  if (line === 'SKILL.md' || line.endsWith('/SKILL.md')) {
    const parts = line.split('/');
    if (parts.length < 2) return null;
    const parent = parts[parts.length - 2];
    return parent && parent !== '.' ? { name: parent, kind: 'skill' } : null;
  }
  const cmd = /(?:^|\/)commands\/([^/]+)\.md$/.exec(line);
  if (cmd) return { name: cmd[1] as string, kind: 'command' };
  if (/(?:^|\/)\.ai\/(?:cezar\/)?skills\/.+\.md$/.test(line)) return { name: null, kind: 'markdown' };
  return null;
}

/**
 * Read one file from the bare clone at the source's ref. Null on any failure.
 * `atCommit` pins the read to an already-resolved commit, so a caller listing
 * many files reads them all at the same commit (and skips re-resolving).
 */
export async function readRemoteSkill(
  src: SkillsRepoSource,
  path: string,
  atCommit?: string,
): Promise<string | null> {
  const bareDir = bareDirFor(src.repo);
  if (!existsSync(join(bareDir, 'HEAD'))) return null;
  const ref = atCommit ?? (await resolveRef(bareDir, src.ref));
  if (ref === null) return null;
  const res = await git(['show', `${ref}:${path}`], LIST_TIMEOUT_MS, bareDir);
  return res.ok ? res.stdout : null;
}

/**
 * List every skill the repo defines at `src.ref`. Reads from the local bare
 * clone only — no network. Empty list when the clone doesn't exist yet or
 * the ref can't be resolved.
 */
export async function listRemoteSkills(src: SkillsRepoSource): Promise<Skill[]> {
  const bareDir = bareDirFor(src.repo);
  if (!existsSync(join(bareDir, 'HEAD'))) return [];
  // An immutable SHA (#428): the tree listing and every body below are read at
  // this one commit, and it is what gets recorded on each skill.
  const commit = await resolveRef(bareDir, src.ref);
  if (commit === null) return [];
  // `--` after the ref keeps a `-`-leading value out of git's option surface.
  const ls = await git(['ls-tree', '-r', '--name-only', commit, '--'], LIST_TIMEOUT_MS, bareDir);
  if (!ls.ok) return [];

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const line of ls.stdout.split('\n')) {
    if (!line) continue;
    const hit = matchSkillPath(line);
    if (!hit) continue;
    const raw = await readRemoteSkill(src, line, commit);
    if (raw === null) continue;
    const { frontmatter, body } = parseFrontmatter(raw);
    const name =
      hit.name ??
      (typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : basename(line, '.md'));
    if (seen.has(name)) continue;
    seen.add(name);
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : undefined;
    skills.push({
      name,
      description,
      body,
      path: `${src.repo}@${src.ref}:${line}`,
      source: 'team',
      team: { repo: src.repo, ref: src.ref, path: line, dir: hit.kind === 'skill', commit },
    });
  }
  return skills;
}

// ---- materialization (directory skills) ---------------------------------------

/**
 * Copy a directory skill (SKILL.md + references/…) out of the bare clone into
 * `<repoRoot>/.claude/skills/<name>/` so claude sees the references on disk,
 * and keep it out of the user's git via `.git/info/exclude`. Returns false
 * when there is nothing to materialize (not a directory skill, no clone…).
 */
export async function materializeSkillDir(repoRoot: string, skill: Skill): Promise<boolean> {
  if (!skill.team?.dir || !skill.team.path.endsWith('SKILL.md')) return false;
  const bareDir = bareDirFor(skill.team.repo);
  if (!existsSync(join(bareDir, 'HEAD'))) return false;
  const ref = await resolveRef(bareDir, skill.team.ref);
  if (ref === null) return false;
  const srcDir = skill.team.path.slice(0, -'/SKILL.md'.length);
  const ls = await git(['ls-tree', '-r', '--name-only', ref, '--', srcDir], LIST_TIMEOUT_MS, bareDir);
  if (!ls.ok) return false;

  const destDir = join(repoRoot, '.claude', 'skills', skill.name);
  let wrote = 0;
  for (const file of ls.stdout.split('\n').filter(Boolean)) {
    const rel = file.slice(srcDir.length + 1);
    // git paths are repo-relative and normalized, but never trust them blindly.
    if (!rel || rel.split('/').includes('..')) continue;
    const show = await git(['show', `${ref}:${file}`], LIST_TIMEOUT_MS, bareDir);
    if (!show.ok) continue;
    const target = join(destDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, show.stdout, 'utf8');
    wrote++;
  }
  if (wrote === 0) return false;
  await excludeFromGit(repoRoot, `.claude/skills/${skill.name}/`);
  return true;
}

/** Append a pattern to git's `info/exclude` (idempotent, non-fatal). */
async function excludeFromGit(repoRoot: string, pattern: string): Promise<void> {
  try {
    // Resolve the real exclude file: in a linked worktree (spec 006) `.git`
    // is a file and `info/exclude` lives in the shared common dir — which
    // also means one exclude entry covers every task worktree.
    const probe = await git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      LIST_TIMEOUT_MS,
      repoRoot,
    );
    const gitDir = probe.ok && probe.stdout.trim() ? probe.stdout.trim() : join(repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    let prev = '';
    try {
      prev = await readFile(excludePath, 'utf8');
    } catch {
      // no exclude file yet
    }
    if (prev.split('\n').includes(pattern)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + pattern + '\n', 'utf8');
  } catch {
    // non-fatal — `.git` might be a linked file (worktree) or absent entirely
  }
}

// ---- in-process cache ----------------------------------------------------------

// Clone attempts are expensive when the network is down (git can hang on
// DNS/TCP), so each source gets one implicit attempt per process. "Refresh"
// always retries.
const cloneAttempted = new Set<string>();
// Isolated review worktrees have no local `.agents/skills` (gitignored, absent
// in a fresh checkout), so codex reads skills straight from this global bare
// cache. A clone left by an earlier run — or one this long-running process
// fetched hours ago — silently serves a stale template. Passive loads therefore
// fetch on the first touch per process and then at most once per TTL, keeping
// the cache current without a manual "Refresh" and without fetching on every
// catalog read. `refresh` (the explicit button / #613's post-update
// invalidateCatalog) still fetches unconditionally.
const PASSIVE_FETCH_TTL_MS = 6 * 60 * 60 * 1_000;
const lastFetchByRepo = new Map<string, number>();

/**
 * Whether a passive (non-`refresh`) load should `git fetch` an existing bare
 * clone: yes on the first touch this process, and yes once the last fetch is
 * older than `ttlMs`. Pure so the freshness policy is unit-tested without git.
 */
export function shouldPassiveFetch(opts: {
  attempted: boolean;
  fetchedAt: number;
  now: number;
  ttlMs: number;
}): boolean {
  return !opts.attempted || opts.now - opts.fetchedAt > opts.ttlMs;
}
// Both maps are keyed by `repoRoot` (multi-project workspace, step 2.6): each
// project resolves its own `.ai/cezar/config.json` → `skillsRepos`, so one
// project's team-skill list must never be served under another project's scope.
const teamSkillsByRoot = new Map<string, Skill[]>();
const firstLoadByRoot = new Map<string, Promise<Skill[]>>();

function initialTeamSkillsLoad(repoRoot: string): Promise<Skill[]> {
  const existing = firstLoadByRoot.get(repoRoot);
  if (existing) return existing;
  const load = loadTeamSkills(repoRoot, false).catch(() => teamSkillsByRoot.get(repoRoot) ?? []);
  firstLoadByRoot.set(repoRoot, load);
  return load;
}

/**
 * The current team-skill list for this project, straight from memory. The
 * first call per `repoRoot` kicks off an async background load (clone + list)
 * and returns immediately — the GUI refetches, so remote skills appear moments
 * later instead of blocking the first `GET /api/skills`.
 */
export function getTeamSkillsCached(repoRoot: string): Skill[] {
  void initialTeamSkillsLoad(repoRoot);
  return teamSkillsByRoot.get(repoRoot) ?? [];
}

/**
 * Wait for the same non-refreshing load kicked off by `getTeamSkillsCached`.
 * The normal catalog read stays immediate; callers use this only for a
 * background convergence read after they have already rendered local skills.
 */
export function waitForTeamSkills(repoRoot: string): Promise<Skill[]> {
  return initialTeamSkillsLoad(repoRoot);
}

/** Refresh: clone missing sources, `git fetch` existing ones, reload the list. */
export async function refreshTeamSkills(repoRoot: string): Promise<Skill[]> {
  const load = loadTeamSkills(repoRoot, true).catch(() => teamSkillsByRoot.get(repoRoot) ?? []);
  firstLoadByRoot.set(repoRoot, load);
  return load;
}

async function loadTeamSkills(repoRoot: string, refresh: boolean): Promise<Skill[]> {
  const config = await loadConfig(repoRoot);
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const src of config.skillsRepos) {
    try {
      if (refresh) {
        const { bareDir, created } = await ensureBareClone(src.repo);
        if (!created) await fetchAll(bareDir);
        cloneAttempted.add(src.repo);
        lastFetchByRepo.set(src.repo, Date.now());
      } else if (
        shouldPassiveFetch({
          attempted: cloneAttempted.has(src.repo),
          fetchedAt: lastFetchByRepo.get(src.repo) ?? 0,
          now: Date.now(),
          ttlMs: PASSIVE_FETCH_TTL_MS,
        })
      ) {
        cloneAttempted.add(src.repo);
        const { bareDir, created } = await ensureBareClone(src.repo);
        // A clone left by an earlier run is very likely behind origin; fetch it
        // so worktree reviews never read a stale skills template.
        if (!created) await fetchAll(bareDir);
        lastFetchByRepo.set(src.repo, Date.now());
      }
    } catch {
      // offline / no access — list whatever an older clone has (or nothing)
    }
    try {
      for (const skill of await listRemoteSkills(src)) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        out.push(skill);
      }
    } catch {
      // degrade: this source contributes nothing
    }
  }
  teamSkillsByRoot.set(repoRoot, out);
  return out;
}
