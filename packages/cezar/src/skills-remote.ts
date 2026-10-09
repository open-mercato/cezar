import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConfig, type SkillsRepoSource } from './config.ts';
import { cezarCacheDir } from './paths.ts';
import { parseFrontmatter, type Skill } from './skills.ts';
import { readJsonCache, writeJsonCache } from './skills-cache-state.ts';

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
const GIT_OUTPUT_CAP = 16 * 1024 * 1024;

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
  if (backgroundWorkAborted) return Promise.resolve({ ok: false, stdout: '', stderr: '' });
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...GIT_HARDENING_ARGS, ...args],
      {
        cwd,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: GIT_OUTPUT_CAP,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_HARDENING_ENV },
      },
      (err, stdout, stderr) => {
        inFlightGitChildren.delete(child);
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    inFlightGitChildren.add(child);
  });
}

// The background team-skills load is fire-and-forget on the read paths, so a
// caller can return while a `git clone`/`fetch` is still writing under the
// cache dir. Tests tear that cache dir down at the end of a file, and a child
// still writing into it turns the removal into ENOTEMPTY. This tracks the
// children and lets a teardown stop them. It is never set on the real paths.
const inFlightGitChildren = new Set<ChildProcess>();
let backgroundWorkAborted = false;

/** Stop every in-flight team-skills git child and refuse to start new ones. */
export function abortTeamSkillsBackgroundWork(): void {
  backgroundWorkAborted = true;
  for (const child of inFlightGitChildren) child.kill('SIGKILL');
  inFlightGitChildren.clear();
}

/** Re-arm after an abort (test teardown only). */
export function resetTeamSkillsBackgroundWorkAbort(): void {
  backgroundWorkAborted = false;
}

/** Resolve once the aborted/in-flight background loads have stopped touching disk. */
export async function settleTeamSkillsBackgroundWork(): Promise<void> {
  await Promise.allSettled([...teamLoadInFlight.values()]);
}

/**
 * Read many blobs from a bare clone over ONE `git cat-file --batch` process,
 * keyed by the object name each line answers for. The names come from an
 * `ls-tree` listing (hex SHAs), never from user input, so there is no option
 * surface to guard. A blob git reports `missing` is simply absent from the map.
 */
function batchReadBlobs(bareDir: string, names: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    if (backgroundWorkAborted || names.length === 0) {
      resolve(new Map());
      return;
    }
    const child = spawn('git', [...GIT_HARDENING_ARGS, 'cat-file', '--batch'], {
      cwd: bareDir,
      env: { ...process.env, ...GIT_HARDENING_ENV },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    inFlightGitChildren.add(child);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlightGitChildren.delete(child);
      resolve(parseBatchBlobs(Buffer.concat(chunks)));
    };
    // A stalled network mount must not park the load forever — and with
    // single-flight every later caller would join it.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, LIST_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      const remaining = GIT_OUTPUT_CAP - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        child.kill('SIGKILL');
        finish();
      }
    });
    child.on('error', finish);
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.write(names.map((name) => `${name}\n`).join(''));
    child.stdin.end();
  });
}

function parseBatchBlobs(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let offset = 0;
  while (offset < buf.length) {
    const newline = buf.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = buf.toString('utf8', offset, newline);
    offset = newline + 1;
    // `<sha> <type> <size>`; a missing object answers `<name> missing`.
    const [name, type, sizeText] = header.split(' ');
    if (!name || type === 'missing') continue;
    const size = Number(sizeText);
    if (!Number.isFinite(size) || size < 0) continue;
    if (offset + size + 1 > buf.length) break;
    if (type === 'blob') out.set(name, buf.toString('utf8', offset, offset + size));
    offset += size + 1; // git terminates each body with a newline
  }
  return out;
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
  return join(cezarCacheDir(), 'skills', key);
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
  if (backgroundWorkAborted) throw new Error('team-skills background work aborted');
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
  // One tree listing (with object ids), then one batched read for every skill
  // body — a bounded two spawns regardless of how many skills the repo holds.
  // `--` after the ref keeps a `-`-leading value out of git's option surface.
  const ls = await git(['ls-tree', '-r', commit, '--'], LIST_TIMEOUT_MS, bareDir);
  if (!ls.ok) return [];

  const entries: Array<{ path: string; sha: string; hit: SkillPathHit }> = [];
  for (const line of ls.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const sha = line.slice(0, tab).split(' ')[2];
    const path = line.slice(tab + 1);
    const hit = path ? matchSkillPath(path) : null;
    if (sha && hit) entries.push({ path, sha, hit });
  }
  const blobs = await batchReadBlobs(bareDir, [...new Set(entries.map((entry) => entry.sha))]);

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const { path: skillPath, sha, hit } of entries) {
    const raw = blobs.get(sha);
    if (raw === undefined) continue;
    const { frontmatter, body } = parseFrontmatter(raw);
    const name =
      hit.name ??
      (typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : basename(skillPath, '.md'));
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
      path: `${src.repo}@${src.ref}:${skillPath}`,
      source: 'team',
      team: { repo: src.repo, ref: src.ref, path: skillPath, dir: hit.kind === 'skill', commit },
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

// ---- in-process + persisted cache ---------------------------------------------

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
let fetchStateHydrated = false;

/** Resolved at call time: tests redirect `HOME`/`CEZ_HOME` before their first load. */
function fetchStatePath(): string {
  return join(cezarCacheDir(), 'team-skills-state.json');
}

/** Seed fetch times from `~/.cache/cez` so a restart inside the six-hour
 *  window does not pay another `git fetch`. Read once, lazily — never at module
 *  load, so a test that redirects `HOME` before its first load is respected. */
function hydrateFetchState(): void {
  if (fetchStateHydrated) return;
  fetchStateHydrated = true;
  const parsed = readJsonCache<{ lastFetch?: Record<string, number> }>(fetchStatePath());
  const lastFetch = parsed?.lastFetch;
  if (!lastFetch || typeof lastFetch !== 'object') return;
  for (const [repo, at] of Object.entries(lastFetch)) {
    if (typeof at === 'number' && Number.isFinite(at) && !lastFetchByRepo.has(repo)) {
      lastFetchByRepo.set(repo, at);
    }
  }
}

function persistFetchState(): void {
  if (backgroundWorkAborted) return;
  writeJsonCache(fetchStatePath(), { lastFetch: Object.fromEntries(lastFetchByRepo) });
}

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
// The list and in-flight maps are keyed by `repoRoot` (multi-project workspace,
// step 2.6): each project resolves its own `.ai/cezar/config.json` →
// `skillsRepos`, so one project's team-skill list must never be served under
// another project's scope. The in-flight map is single-flight per root, and it
// is cleared on completion so the TTL can fire.
const teamSkillsByRoot = new Map<string, Skill[]>();
const teamLoadInFlight = new Map<string, Promise<Skill[]>>();
const lastListByRoot = new Map<string, number>();
// Monotonic per root so a slow passive load cannot overwrite a refresh that
// started after it.
const loadEpoch = new Map<string, number>();

function beginTeamLoad(repoRoot: string, refresh: boolean): Promise<Skill[]> {
  const epoch = (loadEpoch.get(repoRoot) ?? 0) + 1;
  loadEpoch.set(repoRoot, epoch);
  const load = loadTeamSkills(repoRoot, refresh, epoch).catch(
    () => teamSkillsByRoot.get(repoRoot) ?? [],
  );
  teamLoadInFlight.set(repoRoot, load);
  void load.finally(() => {
    if (teamLoadInFlight.get(repoRoot) === load) teamLoadInFlight.delete(repoRoot);
  });
  return load;
}

function initialTeamSkillsLoad(repoRoot: string): Promise<Skill[]> {
  const loadedAt = lastListByRoot.get(repoRoot);
  if (
    teamSkillsByRoot.has(repoRoot) &&
    loadedAt !== undefined &&
    Date.now() - loadedAt < PASSIVE_FETCH_TTL_MS
  ) {
    return Promise.resolve(teamSkillsByRoot.get(repoRoot) as Skill[]);
  }
  return teamLoadInFlight.get(repoRoot) ?? beginTeamLoad(repoRoot, false);
}

/**
 * The current team-skill list for this project, straight from memory. The
 * first call per `repoRoot` kicks off an async background load (clone + list)
 * and returns immediately — the GUI refetches, so remote skills appear moments
 * later instead of blocking the first `GET /api/skills`. Once the list is older
 * than the warm window a later call starts the same background reload, so a
 * long-running server does not serve one boot's catalog forever.
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
export function refreshTeamSkills(repoRoot: string): Promise<Skill[]> {
  return beginTeamLoad(repoRoot, true);
}

async function loadTeamSkills(repoRoot: string, refresh: boolean, epoch: number): Promise<Skill[]> {
  if (backgroundWorkAborted) return teamSkillsByRoot.get(repoRoot) ?? [];
  hydrateFetchState();
  const config = await loadConfig(repoRoot);
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const src of config.skillsRepos) {
    if (backgroundWorkAborted) break;
    try {
      if (refresh) {
        const { bareDir, created } = await ensureBareClone(src.repo);
        if (!created) await fetchAll(bareDir);
        cloneAttempted.add(src.repo);
        lastFetchByRepo.set(src.repo, Date.now());
        persistFetchState();
      } else if (
        shouldPassiveFetch({
          // A persisted fetch from an earlier process counts as attempted — so a
          // restart inside the window skips the boot fetch — but only while the
          // clone it recorded still exists. A deleted cache dir must rebuild,
          // and `ensureBareClone` below is the only path that does.
          attempted:
            cloneAttempted.has(src.repo) ||
            (lastFetchByRepo.has(src.repo) && existsSync(join(bareDirFor(src.repo), 'HEAD'))),
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
        persistFetchState();
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
  // Discard a superseded (older) completion: a refresh racing the passive load
  // must not leave the stale list cached.
  if (loadEpoch.get(repoRoot) === epoch) {
    teamSkillsByRoot.set(repoRoot, out);
    lastListByRoot.set(repoRoot, Date.now());
  }
  return out;
}
