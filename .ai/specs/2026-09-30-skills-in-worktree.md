# Skills in the worktree — native loading instead of inlined bodies

> Slug: `skills-in-worktree` · Status: implemented on `perf-skills-worktree` · Always on, no new setting

## TLDR

A task that selects a directory skill (`<name>/SKILL.md`) no longer carries the skill's whole
Markdown body in its prompt when the agent can load it natively. `provisionSkills`
(`packages/cezar/src/skills-provision.ts`, #1429) already installs the selected skill and the
catalog skills it names into the run's `.claude/skills` and `.agents/skills`. This spec builds on
that: when the provisioned `SKILL.md` provably carries the selected skill, the prompt carries the
skill's name, description, that file's path and one instruction: load it with your skill tool or
read the file. Otherwise the body is inlined as before. A task that starts with `/skill` while its
step already selects that skill no longer receives the body twice. Skill discovery is memoized
in-process, and the team-skill cache refreshes on its documented six-hour TTL, in the background.

## Why this shape

`om-auto-review-pr`'s `SKILL.md` is 20,295 bytes (the whole file, frontmatter included, as
measured for this spec). Inlined with its identity lines (20,670 chars) through `--append-system-prompt` (Claude) or the
first user message (Codex, OpenCode) it is ~5.2 k tokens on every model request of the session,
and ~10.3 k when the task also starts with `/om-auto-review-pr` (the slash expansion inlined the
body a second time). Every supported CLI already has a skill loader that reads the body on demand
from a skills directory, and `provisionSkills` puts the skill there, so the body in the prompt is
redundant wherever that loader is known to work.

## Native discovery matrix (probed locally)

| Backend | Version probed | Project dirs it reads | Probe |
|---|---|---|---|
| Claude Code | 2.1.285 | `.claude/skills` only (`.agents/skills` is not listed) | `claude -p` in a repo holding one probe skill in each dir: lists only the `.claude/skills` one |
| Codex | 0.156.1 | `.agents/skills` only | `codex debug prompt-input` lists only the `.agents/skills` probe, as `name: description (file: …/SKILL.md)` |
| OpenCode | 1.18.30 | `.agents/skills` and `.claude/skills` | `opencode debug skill` lists both probes |
| Pi | — | not verified | — |

`provisionSkills` writes both directories, so every verified backend finds the skill by name.

## Resolved assumptions

| # | Question | Applied default | Why |
|---|---|---|---|
| S1 | Where the skill comes from | Placement is `provisionSkills` alone: the selected skill plus its transitive companions (capped at 24), linked into `<cwd>/.claude/skills/<name>` and `<cwd>/.agents/skills/<name>` (junction, then copy, as fallbacks), on fresh runs, continuations and live `/skill` messages. In place, only a team skill is materialized. This spec adds no copy of its own. | One mechanism places skills; delivery only decides what the prompt says about them. |
| S2 | When a provisioned file may be named | `provisionedSkillFile(cwd, skill)` returns a path only when every existing `<dir>/<name>` entry in `cwd` carries the selected skill. An on-disk skill's entry must hold a `SKILL.md` whose content equals the source file; a team skill's entry must equal the blob this process materialized there in its latest successful `materializeSkillDir` (a failed or foreign materialization does not count). An in-place run's own installed `SKILL.md` counts as itself. | Native loaders pick a skill by NAME. For an on-disk skill, `provisionSkills` never overwrites a tracked or user-owned skill of the same name, and that skill is what the agent loads; a team skill is materialized over any entry of its name, so only a failed materialization leaves a foreign one, so naming a path there is wrong; the inlined body is right. |
| S3 | Continue | `runContinuation` provisions a leading `/skill` (as main does) and the owning step's skill, unless it is an on-disk skill whose entry already passes S2, in which case nothing is reinstalled and the team-skill wait is skipped. A team step skill is always materialized again, so a fetched update lands. It checks `state.cancelled` after provisioning and before the session starts. | A reclaimed worktree comes back without its provisioned entries. The resumed agent loads the step's skill by name through its native loader, and on Codex and OpenCode the session's first user message (resumed history) names the path. Claude's resumed system prompt is the Continue's own and carries no skill. |
| S4 | Write protection | None beyond what `provisionSkills` does: it links the installed skill, so an agent edit through the link changes the source. | Owner decision for #1429; out of scope here. |
| S5 | Which prompt a directory skill gets | Name, description, the absolute `SKILL.md` path from S2, and "load this skill with your skill tool, or read that file before acting; resolve the files it references against its directory". | The agent needs the name for its skill tool and the path for a backend or skill tool that misses it. |
| S6 | Which skills keep the inlined body | Single-file skills, the built-in skill, any skill S2 refuses, a Claude step whose `allowedTools` lacks `Read`, and every skill on a backend outside the verified set (`claude`, `claude-cli`, `codex`, `opencode`), today Pi. | Pi's native loading is unverified, and a skill it cannot find would silently degrade to "plain prompt". Known gap: a Continue that switches backend (#401) carries the earlier turns forward as portable context, so a run started on a native backend and continued on Pi hands Pi the path block, not the body. It degrades to "read that file", which Pi's file tools can do. |
| S7 | Directory access | No grant. The path is always inside `cwd` (a provisioned entry, or an in-place run's own skill); a skill whose only copy is outside `cwd` is inlined. | `--add-dir` is read+write; granting a shared skill directory would let an agent rewrite a skill every run uses. |
| S8 | `/skill` in a task whose step already selects that skill | The opening user prompt drops the slash token and keeps the request; the body (or path block) is delivered once, in the system prompt. A request-less `/skill` becomes "Follow the selected skill /name." | The duplicate was the full body twice in one request. |
| S9 | Which slash expansions follow S5/S6 | The fresh-run opening prompt and a continuation's opening prompt (the backend is known). Live chat messages keep the inlined body. What an earlier turn already delivered is not re-derived when a Continue switches backend (S6). | `deliverMessage` has no backend in `ActiveRun`; adding one is a separate change. |
| S10 | Discovery memo key | `repoRoot` + the mtime of each scanned skills directory, of the directories above each skill file, and of every skill file read (a skill's `references/` are not stamped: a `Skill` carries only `SKILL.md`), re-checked with one `stat` each per call; any change re-walks. A directory that cannot be read is stamped `-1`. The stamp is taken before the file is read. `invalidateSkillsCache(repoRoot)` runs on `POST /skills/refresh` and after a skills update. Team skills, the vendor gate and `importedSkills` are recomposed on every call (they are already in memory). | Directory mtimes alone miss an in-place edit of a `SKILL.md`; the old behavior was "an edit shows up on the next run", and that guarantee is kept on filesystems with sub-second mtimes (APFS, ext4, NTFS). On a 1–2 s mtime filesystem (HFS+, FAT, some network mounts) an edit that lands in the same tick as the scan stays invisible until the next change or a Refresh. |
| S11 | Bodies retained per run (#11) | `ActiveRun.skills` keeps the full list (live `/skill` expansion needs any skill's body), but the `Skill` objects are now the memoized ones, shared by every run of the project instead of one copy per run. | Dropping bodies would need a lazy reload on every live slash message. |
| S12 | Team-skill passive refresh (B19) | A passive touch starts a new background load once the last load is older than the six-hour TTL. One load in flight per `repoRoot`; a newer load (passive or Refresh) supersedes an older one, whose late result is discarded. `waitForTeamSkills` awaits only the very first load; once a list has settled it answers with that list at once while a TTL reload runs in the background. The TTL and the per-repo fetch time use one clock (the load's start; the fetch time never moves backwards), so the interval stays six hours. | The first-load promise was memoized forever, so the TTL check never ran again on a long-running server. Team-skill loading never blocks a run on the network. |

## Default-path diff (AGENTS.md § Changing a mechanism that already works)

With every setting at its default, for the old scenarios:

- **Worktree run with a directory skill on Claude/Codex/OpenCode**: before, `provisionSkills`
  installed it and the prompt also inlined the body. After, the prompt names the provisioned
  `SKILL.md` instead of the body. The skill still reaches the agent, through its own loader or the
  named file.
- **A same-named tracked or user skill already in `.claude/skills` or `.agents/skills`**: before,
  body inlined. After, still inlined (S2).
- **In-place run**: nothing new is written. A directory skill installed inside the checkout is
  named by its own path; one outside it (global) is inlined (S7).
- **Team skill**: named only after this process materialized it successfully and the file still
  holds that blob; otherwise inlined. A restarted server re-materializes on the next step or Continue.
- **Single-file skill, Pi, built-in skill, Claude step without `Read`**: unchanged, body inlined.
- **Continue after a reclaimed worktree**: the owning step's skill is provisioned again (S3);
  before, only a leading `/skill` was.
- **`/skill` typed as a live follow-up**: unchanged (S9).
- **Editing a skill between runs**: still picked up on the next run (S10).
- **Team-skill catalog on a server up for more than six hours**: now refetches passively, in the
  background. Before, only the Refresh button did. A run never waits on that refetch (S12).

What the old mechanism was load-bearing for: the inlined body guaranteed the agent saw the skill
even when it could not read any file, and that it saw THIS skill rather than a same-named one. S2
and S6 keep both: anything not provably loadable as the selected skill is inlined.

Newly paid: nothing measurable. The skills are already provisioned by #1429; delivery adds two
small synchronous file reads per named skill when a prompt is built.

## Not done (deliberately)

Path-only delivery for live `/skill` chat messages (S9). Persisting the team-skill fetch time
across restarts, and replacing the per-file `git show` loop (README Tier 2 #18). Trimming the
native listing to the skills a run uses.
