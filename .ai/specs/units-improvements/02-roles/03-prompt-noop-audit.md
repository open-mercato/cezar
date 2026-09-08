# Prompt no-op audit — units role prompts

Scope: `packages/cezar/src/units/prompts.ts` — the seven prompt string constants
(`CHILD_BRANCH_RULE`, `SPAWN_CONTRACT`, `REPORT_CONTRACT`, `GUARD_RULE`, `CAESAR_PROMPT`,
`LEGATE_PROMPT`, `CENTURION_PROMPT`). Method: `eliminate-no-op` skill's five tests
(inversion, ablation, specificity, counter-default, recovery), applied line by line and
cross-checked against `packages/contract/src/units.ts` (schemas), `packages/cezar/src/workflows/run.ts`
(`spawnChildren`, `carveChildBudgets`, `handleUnitMarkers`), `packages/cezar/src/units/engine.ts`
(`CHILD_ROLE`, `MAX_CHILDREN_IN_FLIGHT`, `unitSubagentTools`, `childSettleReport`), and
`packages/cezar/src/units/markers.ts` (marker parsing/repair). All line numbers verified at HEAD
`df73cfa9` (this worktree's `cez/9be2e435`, forked from `cez/d9628fff`, same commit).

Analysis only — no source file touched. This file is the only artifact this task order created.

## Headline result

The file's own header (`prompts.ts:5-13`) argues the schema restatement in `SPAWN_CONTRACT` /
`REPORT_CONTRACT` is deliberate because the prompt is the *only* place a unit run is taught the
`CEZ:SPAWN` / `CEZ:REPORT` payload shape. Verified: nothing else ships that shape to the running
agent — `markers.ts` only *parses* against the schema, it never renders it back into a prompt or
error message the agent reads mid-session (the refusal note is prose, not the schema). **The
restatement is confirmed load-bearing and none of it is cut here.** What this audit found instead
is a small amount of *rationale/exposition* layered on top of the shape-teaching (the "why" clause
appended to an already-enforced number), and two structural findings that matter more than any
byte count: `retry_limit` has no engine-side enforcement at all (the prose is 100% of the
mechanism), and one `CAESAR_PROMPT` sentence describes a state the current `CHILD_ROLE` ladder
cannot produce.

Line tally: **6 lines/clauses CUT or REWORDed** (3 sub-clause rewords, all inside `CHILD_BRANCH_RULE`
and `SPAWN_CONTRACT`; no full-line cuts survive the five tests), **~40 lines KEPT** as load-bearing.
Estimated saving: **106 bytes per occurrence**, and both rewrites live in constants shared by
`CAESAR_PROMPT` and `LEGATE_PROMPT`, so the saving lands twice — **≈212 bytes off two ~8 KB
prompts (≈1.3% each)**. `CENTURION_PROMPT` (which does not include `SPAWN_CONTRACT` or
`CHILD_BRANCH_RULE`) gets no byte saving from this pass. This is a small, high-signal file; say so
plainly rather than manufacturing cuts to hit a target.

---

## Line-by-line ledger

Legend: **K**=keep, **R**=reword (exact replacement given below), **C**=cut. Test column cites
`packages/cezar/src/units/prompts.test.ts` assertions that pin the exact text (line numbers of the
`it(...)`/`expect(...)` in that file); "—" means no assertion pins the literal wording.

### `CHILD_BRANCH_RULE` (prompts.ts:31-41)

| Line | Current text (verbatim or excerpt) | Verdict | Why | Test touched |
|---|---|---|---|---|
| 31 | `Branches and merges — no code does this for you, so read it twice.` | **R** | "so read it twice" is N2 (unfalsifiable exhortation, no artifact tells you if the reader complied) — inversion ("skim it once") is not something the ablation test can distinguish in output. "no code does this for you" is real context (justifies why the rule exists in prose at all, per the file's own comment at line 28) — keep that half. | none |
| 33 | `You work in your own git worktree, on your own branch. A child you spawn forks off YOUR BRANCH AS YOU COMMITTED IT at the moment of the spawn, into a worktree and a branch of its own.` | **K** | L2 project-specific fact, matches `run.ts:1686-1688` (`baseBranch: parent.branch`, seeded on the CHILD, from whatever the parent last committed — nothing snapshots uncommitted work). Ablation: cut this and a caesar has no way to know spawning forks its committed tip, not its working tree. | — |
| 35 | `COMMIT your work before every CEZ:SPAWN. Anything you left uncommitted does not exist for your children, and they will either redo it or contradict it.` | **K** | L1 counter-default (a model mid-task defaults to "spawn now, commit later"); nothing in `spawnChildren` checks for a dirty tree before forking — this sentence is the entire enforcement. | prompts.test.ts:178 `/COMMIT your work before every CEZ:SPAWN/i` |
| 36 | `Each child's report names the branch it worked on. That branch is the deliverable — a child never merges anything anywhere.` | **K** | `unitReportSchema` (`units.ts:75-83`) has no `branch` field — the branch name only reaches the parent if the child says so in prose (`result`/`evidence`). Removing this line removes the only instruction that gets that fact into the report at all. | — |
| 37 | `When a report arrives, VALIDATE it first: read that branch's diff, run the tests and commands the child claims to have run. A report is a claim until you have checked it.` | **K** | L1 counter-default (models tend to accept a subordinate's "done" at face value); nothing downstream re-verifies a child's claim automatically. | — |
| 38 | `For each child you accept, merge its branch into your own worktree: \`git merge --no-ff <child branch>\`. One child at a time, re-running the repository's checks after each merge.` | **K** | Load-bearing procedure; no code performs this merge (confirmed — `spawnChildren` never merges anything back up). | prompts.test.ts:179 `toContain('git merge --no-ff')` |
| 39 | `Sibling conflicts are yours to resolve. You handed out the scopes, so two children touching the same lines is your decision to settle — resolve it in your worktree and commit the merge. Never send a conflict back down to a child.` | **K** | L6 scope-boundary / recovery path; nothing detects a scope overlap between siblings (`scope` is free text, never cross-validated — see Finding F3). | prompts.test.ts:180 `/sibling conflicts are yours/i` |
| 40 | `A child whose branch you reject is not merged. Either re-task that piece with a new CEZ:SPAWN carrying what you learned, or drop it and say so plainly in your own report.` | **K** | L5 recovery path for a rejected child; no code handles this case either way. | — |
| 41 | `Never merge into the repository's base branch (main / master / develop) yourself, and never push to it. Your branch is where the mission's result accumulates; a human opens the pull request.` | **K**, flagged | Overlaps `GUARD_RULE` (prompts.ts:83) — this is the merge-vs-Guard duplication a sibling centurion owns per the task order; noted once, not resolved here. | prompts.test.ts:181 `/never merge into the repository's base branch/i` |

### `SPAWN_CONTRACT` (prompts.ts:44-59)

| Line | Current text | Verdict | Why | Test touched |
|---|---|---|---|---|
| 44 | `Delegating — the CEZ:SPAWN marker. To hand work down one rank, end your turn with a single line:` | **K** | Sets up the marker; minimal. | — |
| 46 | `CEZ:SPAWN {"children":[{"title":"…","objective":"…", ...}]}` | **K** | The example is round-tripped through `unitSpawnSchema.safeParse` by the test itself — any edit here risks breaking that check. | prompts.test.ts:193-200 (extracts `CEZ:SPAWN (\{.*\})` from the caesar/legate prompt, `JSON.parse`s it, asserts `unitSpawnSchema.safeParse(...).success`) |
| 48 | `The <json> is ONE object on ONE line and the last thing in your message. Keys, and no others:` | **K** | Matches `SPAWN_MARKER_RE` (`markers.ts:30`, `\{[\s\S]*\}\s*$`) exactly — trailing prose after the JSON breaks the match. L1 counter-default (models like to add a closing sentence after a JSON blob). | — |
| 49 | `- "children" — 1 to 4 entries. More than 4 in flight under one parent is refused: cez runs a small number of agents at a time, and a wider fan-out starves your own tree.` | **R** | Two numbers are conflated here: the schema's own `min(1).max(4)` on the array (`units.ts:147-151`, per-call shape — must be taught, nothing else does) and the engine's cumulative in-flight cap (`run.ts:1626-1633`, `MAX_CHILDREN_IN_FLIGHT` = 4, `engine.ts:29`) — a *different* mechanism that happens to share the number 4. Both facts change what the agent should plan for and are kept. The trailing rationale clause ("cez runs a small number of agents at a time, and a wider fan-out starves your own tree") is exposition: the refusal fires and explains itself via its own note (`run.ts:1628-1631`) regardless of whether the agent understood *why* in advance — cutting it changes no accepted or refused payload. | — |
| 50 | `"title" — 1-120 chars, what the task list will show.` | **K** | Shape teaching, already terse; matches `units.ts:134`. | — |
| 51 | `"objective" — 1-4000 chars. The whole assignment in prose. The child sees this and nothing else you know, so state the goal, the context it needs, and what "finished" means.` | **K** | L1 counter-default — models under-specify delegated tasks, assuming shared context that a separate session/worktree does not have. | — |
| 52 | `"scope" — optional, ≤1000 chars. The files, directories or surfaces this child may touch. Give every sibling a DISJOINT scope; two children editing the same file is the one failure mode this design cannot recover from.` | **K**, high value | Confirmed nothing validates scope disjointness between siblings — `scope` is a free-text field on each child (`units.ts:136`), never compared across `spawn.children`. This sentence is the *entire* mechanism preventing overlapping scopes. | — |
| 53 | `"allowed_tools" — optional, ≤16 tool names.` | **K** | Shape teaching, matches `units.ts:140`. | — |
| 54 | `"max_cost" — optional, a positive number of dollars. Carved out of your own remaining budget; a spawn that asks for more than you have left is refused with a note.` | **R** | "Carved out of your own remaining budget" is a planning fact the agent needs *before* spawning (how much it has left to hand out). "a spawn that asks for more than you have left is refused with a note" restates `carveChildBudgets`'s own refusal message (`run.ts:1721-1730`, which already explains itself: `"the requested caps total ${usd(named)} but only ${usd(remaining)} of the budget is left..."`) — the agent learns this the moment it happens, from the engine's own words, not the prompt's. | — |
| 55 | `"success_criteria" — optional, ≤1000 chars. How the child knows it is done.` | **K** | Terse shape teaching, nothing to trim. | — |
| 56 | `"required_evidence" — optional, ≤1000 chars. What the child must show you: test output, a diff, a command and its result.` | **K** | Terse shape teaching. | — |
| 57 | `"retry_limit" — optional integer 0-3.` | **K**, critical | See **Finding F1**: this bound (`units.ts:144`) is never enforced by counting actual respawns — this line, plus the reviewing-reports prose at lines 103/132/160, is the *entire* mechanism. Do not cut, do not treat as boilerplate. | prompts.test.ts:203-205 (`names every optional spawn key`, checks the caesar prompt `toContain('retry_limit')`) |
| 59 | `The JSON must be syntactically valid — every brace and bracket closed, no trailing commas, no unknown keys. Re-read the line before sending it: a payload cez cannot parse spawns nothing and comes back to you as a note.` | **K**, minor note | `markers.ts:25,74-84` actually *repairs* a payload missing its closing brackets (`closeUnbalancedJson`, #936) before giving up — so "every brace and bracket closed" asks for stricter discipline than the parser strictly requires. This is not a no-op (asking for correctness a repair layer happens to backstop is harmless and still the right habit to teach) but it slightly overstates the failure mode; not worth rewording since a false "this always works" impression would be worse than a true "aim for perfect" one. | — |

### `REPORT_CONTRACT` (prompts.ts:62-75)

| Line | Current text | Verdict | Why | Test touched |
|---|---|---|---|---|
| 62 | `Reporting — the CEZ:REPORT marker. When your assignment is settled, end your turn with a single line:` | **K** | Setup. | — |
| 64 | `CEZ:REPORT {"status":"done", ...}` | **K** | Example. Unlike the `CEZ:SPAWN` example, **no test parses this against `unitReportSchema`** — see Finding F4 (missing test, not a prompt defect). | — (gap, see F4) |
| 66 | `The <json> is ONE object on ONE line and the last thing in your message. Keys:` | **K** | Correctly *omits* "and no others" (unlike `SPAWN_CONTRACT` line 48) because `unitReportSchema` is deliberately not `.strict()` (`units.ts:70-74` — an unknown key on a report is stripped, not refused). This asymmetry is accurate, not an inconsistency to fix. | — |
| 67 | `"status" — one of "done", "partial", "failed", "blocked". Be honest: a "done" that is not done costs your commander a whole extra round trip to discover.` | **K** | L1 counter-default (models round up their own success). | — |
| 68-73 | `result` / `evidence` / `confidence` / `side_effects` / `errors` / `recommended_next_action` bullets | **K** | Terse shape teaching, one line per schema field, no padding to trim. | — |
| 75 | `Emit CEZ:REPORT once, at the end. Follow it with CEZ:DONE on the next line only when your own work is genuinely finished.` | **K**, verified precise | This exact sequencing ("REPORT, then DONE on the next line") is what makes `handleUnitMarkers` work at all: `run.ts:1544` strips a trailing `CEZ:DONE` *before* parsing the report marker at `run.ts:1546`, specifically because (per the comment at `run.ts:1526-1528`) "the role prompts ask for 'CEZ:REPORT, then CEZ:DONE on the next line'" — without the strip, `REPORT_MARKER_RE`'s `\s*$` anchor would fail to match once `CEZ:DONE` follows the JSON. Prompt wording and engine parsing are load-bearing *together*; do not reorder. | — |

### `GUARD_RULE` (prompts.ts:79-84)

| Line | Current text | Verdict | Why | Test touched |
|---|---|---|---|---|
| 79 | `The Guard rule — this one is absolute. Before ANY action that is irreversible, financial, or widens your scope, end the turn with CEZ:ASK and stop. That includes: ...` | **K** | L4 safety — never cut on efficiency grounds. | — |
| 81 | `Ask with CEZ:ASK, not in prose: ...` | **K** | Shape teaching for a third marker, same rationale as SPAWN/REPORT contracts. | — |
| 82 | `Never work around a blocked action. ...` | **K** | L1 counter-default (models route around a denial by finding another path to the same effect). | prompts.test.ts:159 |
| 83 | `Open pull requests as DRAFTS. Never merge to the base branch, and never push to it.` | **K**, flagged | Same merge-vs-Guard overlap as `CHILD_BRANCH_RULE:41` — noted once, not resolved (out of this task's scope). | prompts.test.ts:160-161 |
| 84 | `When in doubt about whether something is reversible, it is not. Ask.` | **K** | L1 counter-default, memorable tie-breaker (L3-flavored). | — |

### Role-specific text — `CAESAR_PROMPT` (86-115), `LEGATE_PROMPT` (117-142), `CENTURION_PROMPT` (144-166)

Only the lines *not* already covered above (i.e. not `${SPAWN_CONTRACT}` / `${CHILD_BRANCH_RULE}` /
`${GUARD_RULE}` / `${REPORT_CONTRACT}` interpolations) are new content to classify.

| Line(s) | Current text (excerpt) | Verdict | Why | Test touched |
|---|---|---|---|---|
| 86 | `You are CAESAR — the commander of this mission and the root of its unit tree.` | **K** | Role identity; each prompt is a separate session, this is the only place a run learns its own rank. | — |
| 88 | `You have been given an objective and a budget. Your job is to turn that objective into a plan, delegate it to LEGATES, review what comes back, and decide when the mission is done. Legates command centurions; centurions do the work.` | **K** | Defines the hierarchy the model must reason about; not restated anywhere else the model reads. | — |
| 90 | `You do not edit files yourself. Not one. If you find yourself opening an editor, you have taken a legate's job — decompose it and spawn instead. Reading is different: ...` | **K**, high value | L1 counter-default. Confirmed nothing in `unitSubagentTools` (`engine.ts:104-112`) or elsewhere restricts a caesar's own `allowedTools` — it can technically call `Edit`. This sentence is the *only* thing stopping it. | prompts.test.ts:150-153 `/do not edit files yourself/i` (caesar, legate) |
| 92-96 | Numbered first-turn procedure (read → write order of battle → spawn) | **K** | Concrete procedure, recovery-shaped; ablation test: without it a caesar could spawn on turn one with no plan. | — |
| 99 | `After spawning, end your turn with a line containing exactly CEZ:MONITORING. ... cez parks you and gives your agent slot to them, then wakes you when a report arrives.` | **K**, verified enforced | `MONITORING_MARKER_RE` (`run.ts:127`) is parsed at turn end and drives the actual park/wake/slot behavior (`run.ts:2965-2980`, `3693-3707`) — this is not just a convention, it changes what the engine does with the run's agent slot. | prompts.test.ts:134 `toContain('CEZ:MONITORING')` |
| 101-105 | `Reviewing reports.` bullets (done / partial-transient / failed-real-or-contradictory / blocked) | **K** | Encodes the retry-vs-escalate decision tree; this *is* the enforcement for `retry_limit` and for "do not silently pick a winner between contradictory reports" — nothing else adjudicates. | — |
| 109 | `Budget. ... a spawn refused for lack of budget means the mission is nearly over, and the honest move then is to report what was achieved, not to shrink the remaining children until they cannot succeed.` | **K** | L1 counter-default: `carveChildBudgets` only refuses one spawn attempt; it does not tell the agent *not* to keep shrinking children to fit — that policy is 100% prose. Also connects to the engine's `overBudget` auto-park (`units.ts:115-116`, `run.ts:1581-1586`), which the agent should pre-empt by reporting rather than being cut off mid-turn. | — |
| 113 | `Finishing. ... If you were spawned as part of a larger structure, emit CEZ:REPORT first, in the shape below.` | **K, flagged as dead-in-practice** | See **Finding F2**: `CHILD_ROLE` (`engine.ts:21-25`) never maps anything to `'caesar'` — a caesar run is only ever created at the mission root, by `POST /missions` (`server.ts:3501`, confirmed no other creation path). This conditional describes a state the current ladder cannot reach. Left as-is (forward-compatible with the "Legion" tier the contract file already reserves room for, `units.ts:166`) rather than cut, but flagged so a future editor doesn't assume it's dead weight to delete blindly, or conversely assume it's currently exercised. | — |
| 117 | `You are a LEGATE — a field commander in this mission, reporting to Caesar.` | **K** | Role identity. | — |
| 119 | `You have been given a task order... Your job is to break that order into concrete pieces of work, delegate them to CENTURIONS, review their reports, and report the whole thing back up.` | **K** | Distinct from Caesar's framing (reports *up*, does not decide mission-done). | — |
| 121 | `You do not edit files yourself. ... doing it yourself both burns your budget and leaves your commander with no record of who did what.` | **K** | Same rule as Caesar's line 90, independently justified for the legate's position (has a commander who needs a record) — not a literal duplicate; the extra clause is legate-specific. Not merged with line 90 because the two prompts never share a context window (see "On cross-prompt duplication" below). | prompts.test.ts:150-153 |
| 123-126 | `Your first turn: 1. Read the task order carefully. Everything you know about this mission is in it — you cannot see Caesar's session, and Caesar cannot see yours. 2... 3. Spawn one to four centurions ... Never widen your own scope by giving a child more than you were given; ...` | **K** | The session-isolation reminder ("you cannot see Caesar's session") is L1 counter-default — models assume shared context by default. "Never widen your own scope" is L6 and unenforced (`scope` strings are never checked for containment between parent and child order). | — |
| 130 | `After spawning, end your turn with a line containing exactly CEZ:MONITORING — ...` | **K** | Same engine hook as line 99. | prompts.test.ts:134 |
| 132 | `Reviewing reports. Same rules that bind Caesar bind you: ...` | **K**, good design | Deliberately condensed via cross-reference instead of re-enumerating Caesar's four-bullet list — this is the *opposite* of a no-op: it avoids duplicating 101-105 while still stating the one genuinely different rule (legate carries contradictions *up* to Caesar rather than resolving them itself). No change recommended. | — |
| 136 | `Budget. Your cap came out of Caesar's. ...` | **K** | Legate-specific budget framing (cap comes from a parent, not a top-level allotment). | — |
| 140 | `Finishing. ... your task order is settled ... end your turn with CEZ:REPORT, then CEZ:DONE ...` | **K** | Unconditional (legate always has a commander, unlike root-case Caesar) — correctly simpler than Caesar's line 113. | — |
| 144 | `You are a CENTURION — the rank that actually does the work.` | **K** | Role identity. | — |
| 146 | `You have been given a task order: ... You execute it, in the repository, yourself or through your own sub-agents. Then you report.` | **K** | — | — |
| 148 | `Legionaries. Your backend's own sub-agent tool (in Claude Code, the Task/Agent tool) is your century: ...` | **K**, verified precise | Matches `unitSubagentTools` (`engine.ts:104-112`) exactly: `Task`/`Agent` are auto-injected into `allowedTools` *only* for `role === 'centurion' && backend === 'claude'` — the prompt's "(in Claude Code, the Task/Agent tool)" parenthetical is not decoration, it names the one backend where this is literally true. | prompts.test.ts:145 `/sub-agent/i` |
| 150 | `You must NOT use CEZ:SPAWN. It is refused at your rank, with a note. Legionaries are your backend's sub-agents, not cezar runs — the hierarchy stops at you, deliberately, because a fourth layer of real runs starves the whole tree of agent slots.` | **K**, borderline | `spawnChildren` already refuses a centurion's `CEZ:SPAWN` with a note (`run.ts:1614-1621`, `CHILD_ROLE.centurion === undefined`) — by the letter of "engine already enforces + note", this looks cuttable. Kept anyway: a centurion has broad read access and can `grep`/read this very file, where `CEZ:SPAWN` is documented for other roles — without this line a model that stumbles on `SPAWN_CONTRACT` while reading the repo has no reason to think the marker doesn't apply to it too. The rationale clause is weaker justification but harmless; not worth the risk of trimming a test-pinned phrase. | prompts.test.ts:144 `toContain('must NOT use CEZ:SPAWN')` |
| 152 | `If this backend has no sub-agent tool, that is fine: do the work yourself, sequentially. ...` | **K** | Matches `engine.ts:109-111` comment: "codex/opencode ignore `allowedTools` entirely (#430) and have no equivalent tool" — accurate, not hypothetical. | prompts.test.ts:147 `toContain('no sub-agent tool')` |
| 154 | `While a legionary or a long command is still running ... end your turn with a line containing exactly CEZ:MONITORING ...` | **K** | Same engine hook as caesar/legate's CEZ:MONITORING, tailored wording (no children to wait on, so "legionary or long command" instead of "legates"). | prompts.test.ts:134 |
| 156-160 | `Doing the work: 1. Stay inside your scope. ... 2. Verify before you claim. ... 3. Collect the required evidence ... 4. On a transient failure ... retry, up to the order's retry_limit and no further.` | **K**, critical | This is the *other* half of Finding F1 — the centurion side of retry_limit enforcement is 100% this sentence; nothing counts actual attempts. "Verify before you claim" / "Should work is not evidence" is L1 counter-default. | — |
| 164 | `Finishing. When the order is settled, end your turn with CEZ:REPORT, then CEZ:DONE on the next line. ...` | **K** | See Finding F5 (minor) — this always fires `CEZ:REPORT` even when the centurion is itself the mission root (`unit: 'squad'`, no parent to receive it); harmless (the report is still recorded on the run and visible in the cockpit) but the wording ("your commander") is imprecise for that case. | — |

**On cross-prompt duplication:** `CAESAR_PROMPT`, `LEGATE_PROMPT`, and `CENTURION_PROMPT` never
load into the same context window — only one is ever the active system prompt for a given run. The
"duplicate each other" risk this audit was asked to check for is therefore a *maintenance*
concern (three places to keep in sync), not a *per-turn token* cost, and the four genuinely
identical fragments (`CHILD_BRANCH_RULE`, `SPAWN_CONTRACT`, `REPORT_CONTRACT`, `GUARD_RULE`) are
already factored into shared `const`s at the source level — there is no residual literal
duplication to merge. The near-identical-but-not-identical phrases (e.g. "you do not edit files
yourself" on lines 90 and 121, or the two "Reviewing reports." paragraphs on 101-105/132) are
role-appropriate variations that already avoid restating each other in full; no proposal here
recommends merging them further.

---

## Findings

**F1 — `retry_limit` has no engine-side enforcement; the prose is the entire mechanism.**
Severity: **high**.
Evidence: `packages/contract/src/units.ts:144` bounds it to an int 0-3 on the wire; `packages/cezar/src/units/engine.ts:98` only *echoes* the value into the child's task-order text
(`- Retry limit: ${child.retry_limit}`); nothing in `run.ts` counts how many times a given piece of
work has actually been re-spawned against that number. `grep -rn retry packages/cezar/src/workflows/run.ts`
turns up only an unrelated workflow-step `onFail.retry` mechanism (`run.ts:3503-3514`), not a
unit-spawn retry counter. The only things standing between "retry limit 1" and an unbounded retry
loop are `prompts.ts:103` (caesar), `:132` (legate), and `:160` (centurion). This is not a no-op to
flag for cutting — it is the opposite finding: a future no-op pass on this file must not trim these
three lines on the theory that "the schema already bounds it," because the schema bound (0-3) is a
*payload* constraint, not a *usage* constraint.

**F2 — `CAESAR_PROMPT`'s "spawned as part of a larger structure" branch is currently unreachable.**
Severity: **medium**.
Evidence: `packages/cezar/src/units/prompts.ts:113` — "If you were spawned as part of a larger
structure, emit CEZ:REPORT first". `CHILD_ROLE` (`engine.ts:21-25`) maps `caesar → legate`,
`legate → centurion`, `centurion → undefined`; nothing maps anything `→ caesar`. The only place a
`caesar`-role run record is created is `POST /missions` (`packages/cezar/src/server/server.ts:3501`,
confirmed by `missions-api.test.ts:102`: `expect(store.getRun(id)?.unit).toEqual({ role: 'caesar',
missionId: id })` with no `parentRunId`). A caesar is always the mission root today. The sentence is
plausibly forward-compatible with the "Legion" tier the contract already reserves a comment for
(`units.ts:160-166`: "Legion is cut for the MVP"), so this is not recommended for outright deletion —
but it is dead in the current build and should not be mistaken for tested, exercised behavior.

**F3 — Sibling scope-overlap and scope-containment are entirely prose-enforced.**
Severity: **medium**.
Evidence: `unitSpawnSchema` (`units.ts:128-153`) treats each child's `scope` as an independent,
unvalidated string — there is no check that two children's scopes are disjoint (`SPAWN_CONTRACT`,
`prompts.ts:52`) or that a legate's children's scopes nest inside the legate's own scope
(`LEGATE_PROMPT`, `prompts.ts:126`). Both instructions are therefore load-bearing in full; neither
is a candidate for cutting despite reading, in isolation, like generic project-management advice.

**F4 — No test round-trips the `CEZ:REPORT` example against `unitReportSchema`.**
Severity: **low** (test-coverage gap, not a prompt defect).
Evidence: `prompts.test.ts:193-200` parses and schema-validates the `CEZ:SPAWN` example out of the
caesar/legate prompts; no equivalent assertion exists for the `CEZ:REPORT` example at
`prompts.ts:64`. A future rename of a `unitReportSchema` key (e.g. `recommended_next_action`) would
not be caught by this test file the way a `unitSpawnSchema` rename would.

**F5 — Minor terminology mismatch for a root-of-mission centurion.**
Severity: **low**.
Evidence: `unitSizeSchema` (`units.ts:168`) allows `'squad'` — a centurion as the mission root, with
no parent. `CENTURION_PROMPT`'s finishing paragraph (`prompts.ts:164`) still says "far more to your
commander" unconditionally. Harmless (the report is recorded on the run either way — see
`engine.ts:157-189`, `childSettleReport`, which synthesizes a report even if none is emitted), but
imprecise when there is no commander, only the human reading the cockpit.

**F6 (informational, out of scope) — the merge-vs-Guard duplication.**
`CHILD_BRANCH_RULE:41` and `GUARD_RULE:83` both say "never merge to the base branch / never push to
it," worded slightly differently, inside the same composed `CAESAR_PROMPT`/`LEGATE_PROMPT`. Per the
task order, resolving this (and the separate goal-awareness question) belongs to a sibling
centurion; noted here and not touched.

---

## Proposals

Each proposal is a **REWORD** — no proposal here deletes a bullet or a sentence outright, because
none of the 40+ lines examined pass all five no-op tests without also matching an L-code that keeps
them.

### P1 — trim the unfalsifiable close of the `CHILD_BRANCH_RULE` header

- **Problem:** `prompts.ts:31` ends on "so read it twice" — N2, no artifact distinguishes a model
  that read it twice from one that didn't.
- **File:line:** `packages/cezar/src/units/prompts.ts:31`
- **Current:**
  `Branches and merges — no code does this for you, so read it twice.`
- **Replacement (exact, ready to paste):**
  `Branches and merges — no code does this for you.`
- **Default-path impact:** none — every load-bearing fact in the rest of the block (lines 33-41) is
  untouched.
- **Tests to pin:** none currently assert this literal string; no existing assertion breaks.
  Recommend (not applying here, out of scope): no new test needed — this line isn't semantically
  load-bearing enough to warrant one.
- **Effort:** S. **Risk:** none.

### P2 — separate the shape fact from the rationale in the `children` bullet

- **Problem:** `prompts.ts:49` bundles two enforced numbers (schema per-call max of 4; engine
  cumulative in-flight cap of 4) with a rationale clause the engine's own refusal note already
  supplies at the moment it matters.
- **File:line:** `packages/cezar/src/units/prompts.ts:49`
- **Current:**
  `- "children" — 1 to 4 entries. More than 4 in flight under one parent is refused: cez runs a small number of agents at a time, and a wider fan-out starves your own tree.`
- **Replacement (exact, ready to paste):**
  `- "children" — 1 to 4 entries per CEZ:SPAWN, and no more than 4 may be in flight under one parent at once; a spawn that would exceed either is refused.`
- **Default-path impact:** none — both enforced numbers (4 per call, 4 in flight) stay explicit;
  only the "starves your own tree" rationale clause is dropped.
- **Tests to pin:** `prompts.test.ts:193-200` (schema-validates the *example* line, not this bullet)
  is unaffected; `prompts.test.ts:202-206` does not check this bullet's wording, only that the
  caesar prompt contains the six optional key names as substrings — unaffected since `"children"`
  is not in that checked list.
- **Effort:** S. **Risk:** none.

### P3 — drop the restated refusal mechanism from the `max_cost` bullet

- **Problem:** `prompts.ts:54`'s second clause paraphrases `carveChildBudgets`'s own refusal
  message (`run.ts:1721-1730`), which the agent reads verbatim the moment a spawn is actually
  refused for budget.
- **File:line:** `packages/cezar/src/units/prompts.ts:54`
- **Current:**
  `- "max_cost" — optional, a positive number of dollars. Carved out of your own remaining budget; a spawn that asks for more than you have left is refused with a note.`
- **Replacement (exact, ready to paste):**
  `- "max_cost" — optional, a positive number of dollars, carved out of your own remaining budget.`
- **Default-path impact:** none — the planning-relevant fact ("this comes out of what I have left")
  survives; only the description of the refusal *mechanism* (already self-explanatory when it
  fires) is cut.
- **Tests to pin:** `prompts.test.ts:202-206` checks the caesar prompt `toContain('max_cost')` —
  the literal key name is preserved, so this assertion is unaffected.
- **Effort:** S. **Risk:** none.

### P4 (addition, not a cut) — make the `retry_limit` honor-system explicit

- **Problem:** Finding F1. The three "respawn once, within retry_limit" mentions
  (`prompts.ts:103,132,160`) never say that cezar itself keeps no count — a caesar/legate could
  plausibly assume the engine will refuse a fourth respawn the way it refuses an over-cap fan-out or
  an over-budget spawn, and stop self-policing.
- **File:line:** best inserted immediately after `packages/cezar/src/units/prompts.ts:57` (the
  `retry_limit` bullet in `SPAWN_CONTRACT`, so it reaches every role that can spawn).
- **Current:** *(nothing — this is new text)*
- **Proposed addition (exact, ready to paste, appended to the existing bullet):**
  `- "retry_limit" — optional integer 0-3. No code counts your actual retries against it — track them yourself before spawning again.`
  (Replaces the standalone line `- "retry_limit" — optional integer 0-3.` at `prompts.ts:57` in
  full.)
- **Default-path impact:** makes explicit a constraint that is currently only implicit in the
  "respawn once" wording elsewhere; does not change the schema or any enforced behavior.
- **Tests to pin:** would still satisfy `prompts.test.ts:203-205` (`toContain('retry_limit')`
  substring check, still present); no existing assertion checks the rest of the bullet's wording, so
  none would break. If this addition is adopted, recommend a new assertion pinning the "No code
  counts your actual retries" clause specifically, so a future edit can't silently drop it back into
  looking like ordinary shape-teaching boilerplate.
- **Effort:** S. **Risk:** low (pure addition; slightly lengthens `SPAWN_CONTRACT`, which is shared
  by caesar and legate, by ~85 bytes each — more than P1-P3 save combined, so net token cost across
  P1+P2+P3+P4 is roughly flat, not a reduction. Flagging this trade-off rather than hiding it: F1 is
  a correctness/robustness finding, not a token-budget one, and closing it costs more than the cuts
  save.)

---

## What is missing (would change behaviour, not covered above)

1. **A `unitReportSchema`-validating test for the `CEZ:REPORT` example**, mirroring
   `prompts.test.ts:193-200`'s treatment of the `CEZ:SPAWN` example (Finding F4). This wouldn't
   change the prompt text itself but would catch a schema/prompt drift on the report side that
   nothing currently catches.
2. **An explicit "no code counts this" caveat on `retry_limit`** (Proposal P4) — the single most
   consequential gap found in this pass, because it's the one constraint in the whole spawn contract
   that is pure self-policing with no engine backstop at all (contrast with fan-out cap and budget
   cap, both of which the engine actively refuses).
3. **Nothing here changes what happens when a centurion is itself the mission root** (`unit: 'squad'`)
   versus a spawned child (Finding F5) — a one-clause addition to `CENTURION_PROMPT`'s finishing
   paragraph ("if no one spawned you, your report is only read by the human in the cockpit — write
   it for them") would remove the current ambiguity, but is not proposed as exact replacement text
   here since it is a genuinely new behavioral distinction rather than a trim, and the task order
   scopes this pass to no-op elimination, not new content design.

Explicitly not addressed (per task order, owned by a sibling centurion): the `CHILD_BRANCH_RULE` /
`GUARD_RULE` merge-vs-base-branch wording overlap (Finding F6), and any goal-awareness question.

---

## Byte/token estimates

Composed prompt sizes at HEAD (measured by expanding the `${...}` interpolations in
`packages/cezar/src/units/prompts.ts`, chars ≈ bytes for this ASCII-heavy text, tokens estimated at
chars/4):

| Prompt | Chars | Bytes (UTF-8) | Est. tokens |
|---|---|---|---|
| `CAESAR_PROMPT` (composed) | 7,950 | 8,058 | ~1,988 |
| `LEGATE_PROMPT` (composed) | 7,461 | 7,563 | ~1,865 |
| `CENTURION_PROMPT` (composed) | 4,611 | 4,673 | ~1,153 |

Proposed cuts (P1+P2+P3 combined, before P4's addition):

| Reword | Before (chars) | After (chars) | Saved |
|---|---|---|---|
| P1 (`CHILD_BRANCH_RULE:31`) | 66 | 48 | 18 |
| P2 (`SPAWN_CONTRACT:49`) | 169 | 151 | 18 |
| P3 (`SPAWN_CONTRACT:54`) | 165 | 95 | 70 |
| **Total** | **400** | **294** | **106** |

`CHILD_BRANCH_RULE` and `SPAWN_CONTRACT` are both included in `CAESAR_PROMPT` and `LEGATE_PROMPT` —
the 106-byte saving applies to **each** of those two composed prompts (≈1.3% of ~8 KB), not once
overall. `CENTURION_PROMPT` includes neither constant, so it gets **0 bytes** of saving from P1-P3.
If P4 is also adopted, it adds ~85 bytes back to `SPAWN_CONTRACT` (and therefore to both
`CAESAR_PROMPT` and `LEGATE_PROMPT`), leaving the net change across P1-P4 close to flat — this pass
found a small, tight file, not a bloated one.

Cut vs reword vs keep count: **0 pure cuts**, **4 rewords** (P1, P2, P3, P4 — P4 is additive but
rewrites the same line), **~40 keeps** across the ~46 substantive lines/bullets examined in the
seven constants.

---

## For the summary

- **F1 (high):** `retry_limit` is entirely honor-system — no code counts actual respawns against it; the three prose mentions in `prompts.ts:103,132,160` are the whole mechanism.
- **F2 (medium):** `CAESAR_PROMPT`'s "if you were spawned as part of a larger structure" clause (`prompts.ts:113`) describes a state `CHILD_ROLE` cannot currently produce — a caesar is always the mission root today.
- **F3 (medium):** Sibling scope-disjointness and legate→centurion scope-containment (`prompts.ts:52,126`) are unvalidated by any schema — the prose is the only guard against overlapping child scopes.
