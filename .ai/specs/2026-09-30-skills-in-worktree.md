# Skills in the worktree — native loading instead of inlined bodies

> Slug: `skills-in-worktree` · Status: implemented on `perf-skills-worktree` · Always on, no new setting

## TLDR

A task that selects a directory skill (`<name>/SKILL.md`) no longer carries the skill's whole
Markdown body in its prompt. Cezar copies the project's discovered skills into the task's worktree,
where each agent CLI discovers them natively, and the prompt carries the skill's name, description,
file path and one instruction: load it with your skill tool or read the file. Single-file skills,
and backends whose native skill loading is unverified, keep the inlined body. A task that starts
with `/skill` while its step already selects that skill no longer receives the body twice. Skill
discovery is memoized in-process, and the team-skill cache refreshes on its documented six-hour
TTL instead of never.

## Why this shape

`om-auto-review-pr`'s `SKILL.md` is 20,295 bytes (the whole file, frontmatter included, as
measured for this spec). Inlined with its identity lines (20,670 chars) through `--append-system-prompt` (Claude) or the
first user message (Codex, OpenCode) it is ~5.2 k tokens on every model request of the session,
and ~10.3 k when the task also starts with `/om-auto-review-pr` (the slash expansion inlined the
body a second time). Every supported CLI already has a skill loader that reads the body on demand
from a skills directory; the only thing missing in a worktree was the directory itself, because
`npx skills` installs are gitignored and a fresh worktree does not contain them.

## Native discovery matrix (probed locally)

| Backend | Version probed | Project dirs it reads | Probe |
|---|---|---|---|
| Claude Code | 2.1.285 | `.claude/skills` only (`.agents/skills` is not listed) | `claude -p` in a repo holding one probe skill in each dir: lists only the `.claude/skills` one |
| Codex | 0.156.1 | `.agents/skills` only | `codex debug prompt-input` lists only the `.agents/skills` probe, as `name: description (file: …/SKILL.md)` |
| OpenCode | 1.18.30 | `.agents/skills` and `.claude/skills` | `opencode debug skill` lists both probes |
| Pi | — | not verified | — |

So cezar copies into both `.agents/skills/<name>` and `.claude/skills/<name>`, the same pair of
mirrors `npx skills` writes into the main checkout. The copies are plain directories inside the
working directory, so every backend's file tools reach them without a grant.

## Resolved assumptions

| # | Question | Applied default | Why |
|---|---|---|---|
| S1 | Which skills are materialized | Every discovered project skill (`cezar`, `ai`, `agents` sources) that is a `SKILL.md` directory, into `<worktree>/.agents/skills/<name>` and `<worktree>/.claude/skills/<name>`. Global skills are not copied (every CLI already reads its home dir); team skills keep their existing materializer. | An in-place run already sees these skills natively, so a worktree run now matches it. A skill that calls another skill by name (`om-auto-fix-issue` → `om-verify-in-repo`) needs the whole set, not only the selected one. |
| S2 | When a copy is made | Once per run at `execute` and again at `runContinuation` (both `ActiveRun` construction sites), only when the run has its own worktree (`cwd !== repoRoot`). A destination whose `SKILL.md` matches the source in size and mtime (within 1 ms, since `utimes` drops sub-microsecond precision) is skipped; a copy of the same skill (same declared name) whose source is newer is refreshed in place; a copy edited after it was made (newer than its source) and any other existing path are never touched. | A reclaimed and re-created worktree (`rematerializeReclaimedWorktree`) comes back without the copies; the continuation copies again. A skills update between runs reaches the next Continue, while an agent's own edit to its copy survives it. |
| S3 | Keeping the copies out of the diff | A copy is written only when `git check-ignore` in the WORKTREE says the destination is already ignored (the usual `npx skills` setup ignores both mirrors). Otherwise the skill is skipped. No `info/exclude` write. | `info/exclude` is shared with the main checkout; excluding a name there would also hide the user's own untracked skill of that name from `git status`. A skill the user has not ignored is work in progress they may mean to commit. |
| S4 | Symlink or copy | A recursive copy (`fs.cp`, symlinks dereferenced, timestamps preserved), never a link. Measured for this repo's 42 skills: 680 files, 3,833,634 bytes of content across both mirrors (2,524 KB on disk per mirror); the first copy takes ~200 ms (median of 7, 201–217 ms, load average ~5), a repeat call ~1 ms (84 `lstat` + `stat`, nothing copied). | A link would let an agent that edits a skill (`om-create-skill`, a typo fix in the playbook) write the main checkout from a path inside its own worktree, under `dontAsk`, into a path the worktree ignores — so the edit shows up in no diff, autosave commit or review gate. A copy keeps such an edit inside the worktree. A run is a snapshot of the skills anyway. |
| S5 | Which prompt a directory skill gets | Name, description, the absolute `SKILL.md` path, and "load this skill with your skill tool, or read that file before acting; resolve the files it references against its directory". The path is the worktree's `.agents/skills/<name>/SKILL.md` when that file exists and declares the selected skill's name (frontmatter `name`, else its directory name, as discovery reads it), else the installed copy. | The agent needs the name for its skill tool and the path for a backend or skill tool that misses it. A worktree skill that declares another name is not the selected one. A tracked same-named skill that discovery shadowed with a higher-precedence copy still matches; the agent's native loader would pick that tracked one by name anyway. |
| S6 | Which skills keep the inlined body | Single-file skills (no directory), the built-in skill, a team directory skill whose materialization failed, and every skill on a backend outside the verified set (`claude`, `claude-cli`, `codex`, `opencode`) — today that is Pi. | Nothing to load natively for a single file; Pi's native loading is unverified, and a skill it cannot find would silently degrade to "plain prompt". Known gap: a Continue that switches backend (#401) carries the earlier turns forward as portable context, so a run started on a native backend and continued on Pi hands Pi the path block, not the body. It degrades to "read that file", which Pi's file tools can do. |
| S7 | Directory access (B20) | When the body is not inlined and the file lives outside the worktree (global skills, in-place `.ai/skills`), the skill's directory is appended to `additionalDirectories`, through one helper (`grantsForSkills`) at both spawn sites: the step's first session, and every continuation, which recomputes the grant for the owning step's `skill` plus a leading `/skill`. Only the Claude Code runner reads `additionalDirectories`; Codex and OpenCode get no grant and rely on their own sandbox's read access. | The prompt names a path, and a resumed session already holds it; an agent told to read a directory its tools are not granted is the failure `agentDirectories` exists to prevent. |
| S8 | `/skill` in a task whose step already selects that skill | The opening user prompt drops the slash token and keeps the request; the body (or path block) is delivered once, in the system prompt. A request-less `/skill` becomes "Follow the selected skill /name." | The duplicate was the full body twice in one request. |
| S9 | Which slash expansions follow S5/S6 | The fresh-run opening prompt and a continuation's opening prompt (the backend is known). Live chat messages keep the inlined body. What an earlier turn already delivered is not re-derived when a Continue switches backend (S6). | `deliverMessage` has no backend in `ActiveRun`; adding one is a separate change. |
| S10 | Discovery memo key | `repoRoot` + the mtime of each scanned skills directory, of the directories above each skill file, and of every skill file read (a skill's `references/` are not stamped: a `Skill` carries only `SKILL.md`), re-checked with one `stat` each per call; any change re-walks. The stamp is taken before the file is read. `invalidateSkillsCache(repoRoot)` runs on `POST /skills/refresh` and after a skills update. Team skills, the vendor gate and `importedSkills` are recomposed on every call (they are already in memory). | Directory mtimes alone miss an in-place edit of a `SKILL.md`; the old behavior was "an edit shows up on the next run", and that guarantee is kept on filesystems with sub-second mtimes (APFS, ext4, NTFS). On a 1–2 s mtime filesystem (HFS+, FAT, some network mounts) an edit that lands in the same tick as the scan stays invisible until the next change or a Refresh. |
| S11 | Bodies retained per run (#11) | `ActiveRun.skills` keeps the full list (live `/skill` expansion needs any skill's body), but the `Skill` objects are now the memoized ones, shared by every run of the project instead of one copy per run. | Dropping bodies would need a lazy reload on every live slash message. |
| S12 | Team-skill passive refresh (B19) | A passive touch starts a new background load once the last load is older than the six-hour TTL. One load in flight per `repoRoot`; a newer load (passive or Refresh) supersedes an older one, whose late result is discarded. | The first-load promise was memoized forever, so the TTL check never ran again on a long-running server. |

## Default-path diff (AGENTS.md § Changing a mechanism that already works)

With every setting at its default, for the old scenarios:

- **Worktree run with a directory skill on Claude/Codex/OpenCode**: before, the body was inlined
  and `references/` were read from the main checkout's absolute path. After, the skill (and every
  other project skill) is copied into the worktree and the prompt names the path. The skill still
  reaches the agent, and it no longer depends on the absolute path being granted.
- **An agent that edits a skill in a worktree run**: before, `.agents/skills` did not exist in the
  worktree, so the edit landed in the worktree. After, it lands in the worktree's own copy (S4);
  the main checkout is not reachable through it. Either way the edit sits in an ignored path and
  is not in the diff.
- **In-place run**: nothing is copied. The prompt switches to path-only for directory skills; the
  file is inside the working directory (or granted, S7).
- **Single-file skill, Pi, built-in skill**: unchanged, body inlined.
- **Repo that tracks its skills in git**: the worktree already has them; nothing is copied, and a
  tracked `.agents/skills` is never replaced.
- **Repo whose skill dirs are not ignored**: nothing is copied (S3). Path-only prompt with the
  absolute path, granted (S7).
- **`/skill` typed as a live follow-up**: unchanged (S9).
- **Editing a skill between runs**: still picked up on the next run (S10), and refreshed into an
  existing worktree copy on the next Continue (S2).
- **Team-skill catalog on a server up for more than six hours**: now refetches passively. Before,
  only the Refresh button did.

What the old mechanism was load-bearing for: the inlined body guaranteed the agent saw the skill
even when it could not read any file. S6 keeps that for every backend where native loading is not
verified.

Newly paid: each CLI lists the copied project skills (name + description) in its own prompt. For
this repo that is 42 skills, ~15.7 k chars (~3.9 k tokens), the same list an in-place run already
pays for, and it is prompt-cached by every CLI. And each worktree run's first start copies the
skills: ~3.8 MB and ~200 ms for this repo (S4), ~1 ms on every later start or Continue.

## Not done (deliberately)

Path-only delivery for live `/skill` chat messages (S9). Persisting the team-skill fetch time
across restarts, and replacing the per-file `git show` loop (README Tier 2 #18). Trimming the
native listing to the skills a run uses.
