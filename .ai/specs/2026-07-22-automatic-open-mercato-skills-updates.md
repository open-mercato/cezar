# Automatic Open Mercato skills updates

## TLDR

cezar should detect updates for locally installed skills that came from `open-mercato/skills`, update them through the existing `npx skills` CLI without adding a dependency, and surface actionable update state in the cockpit. A global Settings preference controls automatic application; an environment variable supplies its inherited default, which is enabled when neither source says otherwise.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why | Confirm? |
|---|----------|-----------------|-----|----------|
| Q1 | Is the preference project-scoped or machine-wide? | Machine-wide in `~/.cezar/config.json`. | Global installations and PR #603's skill selection already follow the user across projects. | ok |
| Q2 | What does “automatically update” mean? | Check in the background, then apply a detected update automatically when enabled; disabled mode still checks and offers the manual button. | This makes the checkbox useful without hiding available updates from users who opt out. | ok |
| Q3 | Which installations may cezar modify? | Only project/global entries tracked by the upstream skills CLI with source `open-mercato/skills`; never untracked folders or other sources. | Preserves manually maintained skills and local precedence while supporting normal manual `npx skills add` installations. | ok |
| Q4 | When is the post-update migration skill run? | Never silently; after a successful file update, ask whether to start a new `/om-apply-upgrade-notes` session. | That playbook can change generated repository descriptors, so the user explicitly confirms the agent-driven run. | ok |

## Problem Statement

PR #603 made the default Open Mercato catalog manageable without breaking existing installations: the global `importedSkills` value is tri-state, and local/project skills retain precedence. It does not update copies installed into `.agents/skills` or agent mirrors. Users must currently leave cezar, remember whether their installation is project or global, run the correct update command, and then remember the upgrade-notes playbook.

The feature must work in cezar's normal constrained environments: `gh` may be missing or unauthenticated, the machine may be offline, `npx` or the skills CLI may be unavailable, `$HOME` may be read-only, and multiple cezar servers may share one global installation. None of these may block boot or hide the existing Skills catalog.

Success means:

- installations tracked as originating from `open-mercato/skills` are checked in both project and global scopes;
- an inherited-on global preference automatically applies detected updates;
- disabling it retains detection and a manual update action;
- the Skills navigation row marks actionable update state, and Manage skills explains and performs the update;
- local, manually copied, symlinked-development, custom-repository, and non-Open-Mercato skills are never overwritten merely because cezar discovered them;
- unavailable tools, auth, or network degrade to a concise status with retry, never a boot failure.

## Proposed Solution

Add a small `SkillsUpdateService` that owns discovery, checking, update execution, caching, and cross-process exclusion. It shells directly to the already-available Node toolchain (`npx`) with an argument array and bounded output; it does not import or add the upstream CLI as a dependency and does not use `gh`.

The service reads the upstream skills lock metadata rather than inferring ownership from directory names. It selects only tracked entries whose normalized source is `open-mercato/skills` or its canonical GitHub URL, groups their names by project/global scope, and invokes the upstream CLI with those explicit names. The upstream repository documents `npx skills update -p` and `-g`; the current CLI also accepts skill names, allowing cezar to avoid updating unrelated sources.

Detection is background-only. It starts after the server is listening, is deduplicated across project contexts, and refreshes at a conservative six-hour TTL plus explicit user refresh. Automatic application runs once per newly observed remote version/hash when enabled. Manual update is available whenever detection reports an update or a previous automatic attempt failed.

After a successful update, cezar refreshes its skill catalog, presents a persistent follow-up explaining that `/om-apply-upgrade-notes` applies repository descriptor migrations while preserving local edits, and asks whether to start that skill in a new session. Declining has no side effects.

Alternatives rejected:

- Updating the cached team repository only: that refreshes cezar's read-only team catalog but not agent-installed skills.
- Running `npx skills update -p/-g` without names: it can modify skills from unrelated sources.
- Comparing GitHub commits directly: it duplicates upstream lock/update semantics, introduces authentication/rate-limit handling, and would still need the CLI to preserve install layout.
- Watching or rewriting discovered skill directories: ownership cannot be established safely from a directory alone and would break manual copies or development symlinks.

## Architecture

### Backend service

Create `src/skills-update.ts` with one process-wide `SkillsUpdateService`, injected into server dependencies and disposed with the server. Its public surface is deliberately small:

```ts
type SkillsUpdateState = {
  status: 'idle' | 'checking' | 'available' | 'updating' | 'current' | 'unavailable' | 'error'
  available: boolean
  autoUpdateEnabled: boolean
  inherited: boolean
  checkedAt: string | null
  updatedAt: string | null
  scopes: Array<{
    scope: 'project' | 'global'
    projectId?: string
    status: 'idle' | 'checking' | 'available' | 'updating' | 'current' | 'unavailable' | 'error'
    available: boolean
    skills: string[]
    checkedAt: string | null
    updatedAt: string | null
    reason?: string
  }>
  needsUpgradeNotes: boolean
}

check(repoRoot: string, force?: boolean): Promise<SkillsUpdateState>
update(repoRoot: string): Promise<SkillsUpdateState>
snapshot(repoRoot: string): SkillsUpdateState
```

Implementation constraints:

- Execute the absolute `npx` adjacent to `process.execPath` when present, falling back to a PATH probe; use `execFile`/`spawn` with argument arrays, `shell: false`, a timeout, an output cap, and no environment logging.
- Resolve the installed `skills` CLI through `npx --yes skills ...`. `--yes` suppresses package-install prompts; missing `npx`, npm cache failure, offline resolution, unsupported CLI output, and non-zero exit all become `unavailable`/`error` state.
- Inspect project `skills-lock.json` and global `~/.agents/.skill-lock.json` tolerantly. Unknown versions/shapes produce a scope-specific unavailable reason and no mutation. Normalize only the documented GitHub shorthand/URL spellings; never accept lookalike hosts.
- Use the current upstream machine-readable listing where it can prove source/scope; lock metadata remains the ownership authority. Do not treat cezar's own `Skill.source` enum as installation provenance.
- Call `npx --yes skills update <sorted unique OM names...> -p -y` from the registered project root and the equivalent `-g -y` for global entries. Run scopes serially, preserve partial success, then force a check and refresh both the local discovery query and team-cache-backed catalog.
- Serialize check/update operations in-process. Also acquire a short-lived exclusive lock under `~/.cache/cez/skills-update.lock` with PID/timestamp stale recovery so two cezar servers cannot update the same global installation concurrently. Failure to create a cache directory disables automation for that attempt only.
- Cache status in memory, keyed by project id plus one machine-global scope, not a required state file. A restart or another server may recheck/reapply; upstream hash comparison, the TTL, explicit-name idempotence, and the lock keep that safe. The feature does not promise once-per-version persistence.
- Never require or invoke `gh`. GitHub credentials, if the upstream CLI chooses to use them, remain its concern and are not captured or displayed by cezar.

### Scheduling and workspace lifecycle

One coordinator owns the machine-global check and a per-project check for every non-missing registered project. After the server starts listening, it snapshots the workspace registry, checks the global scope once, and schedules project checks with bounded concurrency. Project-added events enqueue that project; project removal cancels future work and evicts its cache entry; a gone root records unavailable state without instantiating a project context. Opening the Skills page may request detection for the active project but never broadens the registered set.

Only the background coordinator may turn a successful detection into automatic application. GET routes remain read-only and may enqueue detection only; they never directly or indirectly apply an update. A single process-wide queue and the filesystem lock deduplicate global work across project contexts and servers.

### Preference precedence

Add optional `skillsAutoUpdate?: boolean` to `~/.cezar/config.json` using the existing tolerant, `.passthrough()` workspace schema and merge writer. Effective value:

1. explicit workspace setting;
2. `CEZ_SKILLS_AUTO_UPDATE` (`0` disables, `1` enables; invalid/unset is ignored);
3. `true`.

The API returns both the stored nullable value and effective value so the UI can say “On (default)” accurately. Add the env variable to `.env.example` and the README env table in the same change.

This requested network-on and external-file-mutation default is an explicit exception to AGENTS.md's normal “exposure/cost features are opt-in and off by default” rule. The implementation PR must amend AGENTS.md and `BACKWARD_COMPATIBILITY.md` in the same change to record the owner-approved exception, its off switch, and its bounded behavior; review must treat omission of that documentation as blocking. Checks remain delayed, bounded, cached, and non-blocking.

### Compatibility with PR #603 and discovery

This feature does not change `importedSkills`, `gatedSkillsRepos`, `filterImportedTeamSkills`, skill directory precedence, or the `skillsRepos` config shape.

- `importedSkills` continues to decide which default team-catalog skills appear.
- The update service independently manages only upstream-CLI-tracked installed copies.
- A local discovered skill still wins a name collision after an update.
- A project that defines custom `skillsRepos` keeps its existing catalog behavior.
- Manually copied/untracked Open Mercato directories are reported as unmanaged and left untouched; the UI explains how to update them manually.
- Development symlinks into a checkout are unmanaged and must not be replaced.

This preserves `BACKWARD_COMPATIBILITY.md` sections 5 and 9. New config and response fields are additive and optional.

## Data Model

`~/.cezar/config.json` gains one optional key:

```json
{ "skillsAutoUpdate": false }
```

Absence is meaningful and must remain absence on unrelated writes. No migration is required. The effective default is computed at read time; the writer never materializes it. Existing unknown-key preservation, atomic rename, permissions, and read-only-home degradation remain unchanged.

Update/check state is ephemeral and contains no tokens, raw child-process environment, or complete stderr. User-facing reasons are normalized to bounded categories such as “npx is unavailable,” “offline,” “installation is not tracked,” or “update command failed.” The `needsUpgradeNotes` callout lasts for the current server process only: cezar cannot observe an independently run agent skill, so a restart clears it and the UI never claims migration completion.

## API Contracts

Workspace configuration is extended additively:

- `GET /api/workspace/config` adds `skillsAutoUpdate: boolean | null` and `effectiveSkillsAutoUpdate: boolean`.
- `PUT /api/workspace/config` accepts `skillsAutoUpdate?: boolean | null`; `null` clears the stored override and restores environment/default inheritance.

Workspace-level update routes are single-mounted, not project aliases:

- `GET /api/workspace/skills-update?projectId=<id>` returns the cached `SkillsUpdateState` immediately and may schedule a stale detection-only check. Unknown/gone projects follow the existing 404/409 registry contract. Automatic apply is owned exclusively by the protected background coordinator, never by GET handling.
- `POST /api/workspace/skills-update/check` validates `{ projectId }`, forces a bounded check, and returns state.
- `POST /api/workspace/skills-update/apply` validates `{ projectId }`, returns `409` if another update owns the lock, applies eligible updates, and returns final state.

All bodies use zod `safeParse`; all failures return `{ error }` plus the latest safe state where useful. Mutations remain behind the global `/api/*` origin/CSRF guard. The endpoints never accept commands, paths, repository URLs, skill names, or scope from the browser.

The existing `POST /api/skills/refresh` remains the team-repository refresh action and is not repurposed.

## UI/UX

### Global Settings

Add a global “Skills” settings section at `/settings/global/skills` with one switch:

**Update Open Mercato skills automatically** — “Checks installed Open Mercato skills in the background and applies available updates. Other skills and untracked folders are never changed.”

The value reads from workspace config. When no override exists, show `On (default)` and a secondary line naming `CEZ_SKILLS_AUTO_UPDATE` when it supplied the default. Toggling writes an explicit boolean. Include “Use default” to clear the override. The control stays usable even when no installation exists; a quiet status says “No tracked Open Mercato installation found.”

### Sidebar marker

Extend the `NavItem` badge contract beyond the Inbox-only boolean so the Skills row can render a small accessible dot/badge when state is `available` or an automatic attempt failed. The marker has an `aria-label`/screen-reader string “Skills update available,” does not animate, and appears in both desktop and mobile navigation. It is absent during initial loading, current, unavailable, or updating states; errors become a marker only when an update was already proven available.

The global status query is fetched once by the app-shell container and shared through TanStack Query, preserving the one-global-SSE rule. No polling faster than the backend TTL is needed.

### Manage skills

At the top of PR #603's Manage skills detail panel, add a compact update card above the selection controls:

- `available`: “An update is available for your installed Open Mercato skills.” Primary button: **Update now**; secondary text lists project/global scope without exposing paths.
- `updating`: disabled button with progress label; keep the current catalog visible.
- `current`: “Installed Open Mercato skills are up to date,” with last-check time and **Check again**.
- `unavailable`: neutral explanation such as “Automatic updates aren’t available because npx could not be found.” Keep manual command examples (`npx skills update -p` / `-g`) copyable, but do not claim they are safe for unrelated sources.
- partial/error: name the successful and failed scopes, keep **Retry**, and never discard the usable catalog.
- success: refresh the skills list, clear the sidebar marker, toast the result, show a persistent callout, and open a Yes/No dialog asking whether to start `/om-apply-upgrade-notes` in a new session. Yes creates the skill-backed run for the active project and opens it; No closes the dialog without starting a run.

The existing skill checkboxes remain solely catalog curation. Explain the distinction: “These checkboxes choose what cezar shows; updates refresh installed skill files.” The update button is shown only when tracked Open Mercato installations exist and an update is available or retryable.

Illustrative mockups:

- [Manage skills — update available](assets/automatic-open-mercato-skills-updates/mockup-01-manage-skills-update.html)
- [Global Settings — automatic updates](assets/automatic-open-mercato-skills-updates/mockup-02-settings-skills.html)

## Edge Cases & Failure Scenarios

| Scenario | Required behavior |
|---|---|
| `npx`/Node toolchain absent | Status is unavailable; boot, catalog, settings, and manual skill use continue. |
| Offline, DNS failure, rate limit, private source auth failure | Keep last safe state, show retryable reason, apply exponential backoff within the six-hour ceiling; never ask for or print credentials. |
| `gh` absent/unauthenticated | No effect: the feature never invokes `gh`. |
| No tracked Open Mercato entries | No subprocess update, no sidebar badge, quiet “not installed/tracked” state. |
| Only manual copies or development symlinks exist | Leave them unchanged and explain they are unmanaged. |
| Project and global entries both exist | Check both; update serially; report partial success independently. |
| Non-Open-Mercato skills share the lock | Pass explicit OM names so unrelated entries cannot update. |
| Imported selection excludes an installed skill | Update ownership is independent of visibility; tracked installed OM skills may update, but curation remains unchanged. |
| Two servers race | One owns the cache lock; the other returns 409/cached updating state and retries after the owner finishes or the lock becomes stale. |
| Server exits mid-update | Upstream command owns file-level behavior; stale lock recovery permits a later retry. Never synthesize success. |
| Upstream output/lock schema changes | Treat unrecognized data as unavailable and preserve files; fixture tests pin accepted shapes. |
| Read-only home/cache | Preference write returns existing route error; check/update degrades without changing boot behavior. |
| Automatic update succeeds but upgrade notes remain | Clear “update available,” set process-local `needsUpgradeNotes`, retain the follow-up callout until server restart, and ask before starting an agent task; never claim to detect completion. |
| `CEZ_DRY_RUN=1` | Use a deterministic mock state and never invoke `npx` or network, so UI/E2E tests stay offline. |

## Risks & Impact Review

- **External CLI contract:** output and lock formats can evolve. Keep parsing isolated, fixture-tested, tolerant, and fail closed on provenance.
- **Unintended writes:** updating by broad scope could alter unrelated skills. Explicit proven OM names and source validation are mandatory, not an optimization.
- **Concurrent global writes:** multiple cezar processes share global skills. The cache lock and serialized scopes prevent overlapping updates.
- **Network/cost default:** the requested default is enabled as an explicit documented exception to the repository's normal safe-default rule. All work happens after boot, with a long TTL, bounded retries, and an explicit env/Settings off switch.
- **Post-update migrations:** updated playbooks may expect descriptor changes. Keeping `/om-apply-upgrade-notes` explicit avoids silently changing repositories while ensuring the user sees the required hand-off.
- **Rollback:** turn off the setting or set `CEZ_SKILLS_AUTO_UPDATE=0`; the feature adds no required state. A bad upstream skill version is rolled back with the upstream CLI/manual reinstall mechanism, not by cezar maintaining a second package cache.
- **Security:** browser input cannot select executable names/arguments. Child processes use fixed executables and argument arrays. Errors are bounded/redacted. Existing request-origin protection covers mutations.

## Phasing

Phase 1 establishes a read-only, fail-closed update detector and additive API. Phase 2 adds the workspace preference and safe automatic/manual application. Phase 3 adds the Settings, marker, Manage skills states, and end-to-end evidence. Each phase leaves the cockpit usable and can ship independently behind the effective preference.

## Implementation Plan

### Phase 1 — Provenance-aware detection

1. Add `src/skills-update.ts` with tolerant project/global lock readers, canonical Open Mercato source matching, absolute-`npx` discovery, fixed-argument execution, output bounds/timeouts, in-process deduplication, cache lock, TTL, and `CEZ_DRY_RUN` behavior. Add focused unit tests for missing/corrupt/unknown locks, manual folders, mixed sources, project/global grouping, absent tools, offline failures, output redaction, timeouts, and concurrent calls.
2. Add the workspace-level GET/check routes in `src/server/server.ts`, wire one shared service into server lifecycle, and add API types/client/query hooks in `web/app/src/api/`. Extend server route/security tests to prove body validation, 404/409 project resolution, immediate cached reads, and that no route accepts executable inputs.

### Phase 2 — Preference and update execution

3. Extend `src/workspace/config.ts` and the workspace config API with nullable stored/effective `skillsAutoUpdate`, preserving `.passthrough()`, per-key `.catch`, raw-key absence, atomic merging, and read-only degradation. Add `CEZ_SKILLS_AUTO_UPDATE` parsing in one pure helper plus tests for explicit > env > true precedence. Update `.env.example`, README, API types, and compatibility notes.
4. Implement explicit-name project/global updates, per-scope outcomes, cross-process locking, post-success forced recheck, and catalog invalidation. Test argument arrays exactly, especially that unrelated/manual skills are excluded and `gh` is never probed. Add post-listen scheduling across the workspace registry, project-added/project-removed handling, one global owner, and prove failures do not reject startup. Update AGENTS.md and `BACKWARD_COMPATIBILITY.md` with the explicit default-on exception.
5. Add apply route validation and mutation conflict behavior. Cover automatic-on, explicit-off, env-off, no-installation, partial success, stale lock, and dry-run paths in server/unit tests.

### Phase 3 — Cockpit surfaces

6. Register a global Skills settings section in `web/app/src/routes/settings/registry.tsx`; implement the switch, inherited-state copy, reset-to-default action, unavailable/no-installation states, and component tests. Update the registry/path tests for the additive route.
7. Generalize sidebar badges in `web/app/src/components/nav-items.ts` and `app-shell.tsx`, feed update state once from `app-shell-container.tsx`, and test desktop/mobile rendering plus accessibility and no-marker states.
8. Extend `web/app/src/components/skills-import-panel.tsx` and `web/app/src/routes/skills.tsx` with the update card, check/apply mutations, retry/partial-success/current states, catalog refresh, upgrade-notes callout, and clear curation-vs-update copy. Add reordered-response tests so slower checks cannot overwrite a newer update result.
9. Run the full validation gate. Exercise missing `npx`, offline, project-only, global-only, mixed-source, automatic-off/manual update, and concurrent-server flows. Run `npm run test:e2e` and capture Settings, sidebar badge, successful update, failure degradation, and mobile navigation evidence.
