# Manager plan usage: short sessions, cezar-owned memory, work in tasks

Status: **approved 2026-11-21: all three steps, in order; session rule 55-min idle / 100k.** Step 1 = #2384 (cost fix) + #2385 (connectors, per-turn stats); step 2 = memory, short sessions and `cez-manager history` (implemented as specified; watches and jobs always start fresh); step 3 = output and boilerplate trims, popover.
Report with charts: task Assets → `manager-plan-usage-report.html`.
Builds on: `2026-10-31-managers.md`, `2026-11-12-manager-connectors.md`,
`2026-11-20-manager-plan-usage-popover.md` (PR #2363).

## Owner direction (2026-11-21)

Keep Opus and do not tune the model. Give managers a local, agent-agnostic memory of what the
user wants remembered, and start new sessions from that memory instead of one endless
conversation. Most work happens in tasks, so a manager reads extra context only when it needs it.
Track whether managers should do more themselves.

## 1. Evidence

Source: manager "Mobile app creator" (`86ab8a70`). Claude session `2fd8a2fe` (live since
2026-11-19 20:40 UTC, 118 turns, 266 model requests). Also its watch session `28b16dcc`, six
older sessions, and `~/.cezar/usage-ledger`. Prices were fitted from the session's own
`cost-state` records (least squares, R² = 1.00): Opus 5.5 at $4/M input, $20/M output,
$0.20/M cache read and $8/M cache write (1-hour TTL). "$" below is the API-equivalent cost, the
same figure cezar's ledger uses to split plan shares. Model `claude-opus-5-5`, effort `medium`
on every request.

### 1.1 The context never resets

| | |
|---|---|
| Context, first request (2026-11-19 20:40) | 30,195 tokens |
| Context, last request (2026-11-21 06:39) | 962,295 tokens |
| Growth | ≈ 7.9k tokens per turn, never compacted |
| Requests per turn | 2.25 on average, 9 at most (one per tool call, plus one) |
| Cost of the 118 turns | $51.9: cache reads $25.0, cache writes $24.5, output $2.4 |

Earlier sessions did the same. `a4ee7d0e` (Oct 31 – Nov 16) ran 787 requests up to 964k tokens
and was auto-compacted twice. `0d35a1be` peaked at 959k and was compacted 4 times.

**Output, which is the manager's own writing and reasoning, is 4.6% of the cost.** The other
95% is re-reading the history it carries.

### 1.2 Where the 962k tokens come from

Estimated with a char→token ratio of 2.35, calibrated by regressing each request's cache write
on the content added since the previous request. The estimate reconciles with the measured
total (540k + 373k + 30k base ≈ 943k of 962k).

| Part | ≈ tokens at the end | Share |
|---|---|---|
| **Connector material**: `deferred_tools_delta` (173×) and `mcp_instructions_delta` (172×) for Gmail, Drive, Calendar, Telemetry, Wispr Flow, DaVinci Resolve and Claude Docs | **≈ 540k** | **≈ 56%** |
| User and wake prompts (119) | ≈ 111k | 12% |
| Tool results (245) | ≈ 85k | 9% |
| Assistant thinking, text and tool calls | ≈ 185k | 19% |
| System prompt, tools and the rest | ≈ 40k | 4% |

**Connector churn.** Each turn is a new `claude --print --resume` process. Its MCP servers start
out *pending*, then connect, so every turn appends a "removed" delta and an "added" delta: on
average 7.3k characters of tool names and 3k characters of server instructions. The manager
denies all of these servers (spec 2026-11-12): they reach its context only because cezar never
tells Claude not to load them. `buildClaudeArgs` passes no `--strict-mcp-config` and does not
switch off claude.ai connectors.

**Repeated prompt text.** Across the 62 follow-ups, the "Act on it now…" rules come to 69k
characters. The "Your questions still waiting on the user" list appears in 105 prompts (31.5k
characters). Exact duplicate paragraphs come to 90k characters (≈ 38k tokens).

**Large command output.** One `status` returned 29k characters (262 lines) and one `attention`
returned 15.8k characters (155 lines). About 80% of those lines are `task-finished`. In this
session that adds up to about 2% of the context, because the manager rarely called them.
Followed-task reports in follow-ups (`TASKS-…` fences) add another 27.6k characters.

### 1.3 The expensive turns are cache re-writes

The 1-hour cache expires while the manager sits idle. The next turn then re-writes the whole
history at $8/M.

| Turn (UTC) | Idle before | Context | Cost | of which cache write | Ledger share of the 5h window |
|---|---|---|---|---|---|
| 2026-11-21 06:28 (the reported reply) | 9.5 h | 942k | **$8.36** | $7.54 | **5.08 pp** |
| 2026-11-20 20:31 | 3 h | 883k | $6.97 | $6.96 | **7.0 pp** |
| 2026-11-20 11:32 | 3 h | 249k | $2.07 | $1.89 | — |

Those three turns cost $17.4, a third of the session. A *warm* turn at 900k costs about $0.45
and still shows as ≈ 0.95 pp in the ledger, so 29 ordinary chat turns made up the manager's 21 pp
of the 2026-11-20 20:30 window. The watch session shows the same problem in small: one check
every 4 hours, every one of them cold, with its context growing from 48k to 240k. That is $8.94
for 11 requests.

### 1.4 What the manager actually does

Of 247 tool calls, 82 routed work (`task say/create/follow`, merge, proposals), 70 wrote
`files/` for command text, 16 read cezar state, 54 ran `gh`, and 25 read code. Its own
investigation (`gh`, Read/Grep) is about a third of the calls but cheap. What costs is carrying
the history into every call.

### 1.5 Instrumentation bugs found

* A manager chat message's `costUsd` is the **session's cumulative** cost (≈ $50 on each recent
  reply), not the turn's own cost. As a result, `state.costUsd` reads $70,247. The ledger's
  per-message `estimatePp` is right.
* Nothing records context size, requests, cache read/write or idle gap per turn, so a spike
  cannot be explained from the cockpit.

## 2. Design

### 2.1 Manager memory owned by cezar (agent-agnostic)

* **Store:** `~/.cezar/managers/<id>/memory.json`, next to `state.json` (manager state lives in
  `~/.cezar`, never `.ai/cezar`). It is written atomically with tmp+rename. A missing or corrupt
  file degrades to empty with one warning.
* **Entry:** `{ key (kebab slug, unique), kind: preference|feedback|decision|pointer, text
  (≤ 280 chars), why? (≤ 200), updatedAt, source: user|manager|import }`.
* **Budget:** 40 entries and 6 KB rendered, both enforced. A write over budget is refused with
  the list of the oldest entries, so the manager has to replace or remove one. Nothing is
  silently dropped.
* **Dedup and replace:** a write is keyed by `key`, so writing an existing key replaces that
  entry. The CLI also refuses a near-duplicate (same normalized text) and names the key it
  duplicates.
* **What goes in:** preferences and feedback ("full PRs, not drafts", "HTML design before UI",
  "fix every review finding"), standing decisions, and pointers to ongoing work
  ("mobile stack: fixes go into the owning PR", "tracking cezar#2363"). Transcripts, task output
  and anything recomputable from cezar state stay out. The system prompt says so, and the
  280-character limit enforces it.
* **Writing it:** `cez-manager memory list|set <key> --kind … "<text>"|remove <key>`. This goes
  through the same CLI and approval-free route family the manager already uses on every runner,
  so Claude, Codex, OpenCode and Pi behave the same. The user's own edits come from **Manager
  settings → Memory**: a list with inline edit, delete, add, and a budget meter.
* **Reading it:** the memory is rendered into the system prompt of every new session, as a short
  "What the user asked you to remember" block. It is not re-sent on resumed turns.
* **Migrating Claude auto-memory:** today the manager's memory is Claude Code's own: `MEMORY.md`
  plus one file per fact under
  `~/.claude/projects/<manager workdir slug>/memory/`. For this manager that is 7 feedback
  entries, 8.2 KB and about 2k tokens, which already fits the budget. The migration runs once,
  when a manager first runs after the upgrade. It parses each file's frontmatter (`name` →
  `key`, `type` → `kind`, `description` + body → `text`/`why`, truncated with a note), writes
  `source: import`, and leaves the Claude files untouched. After that, a Claude manager's turns
  turn Claude auto-memory **off**, so there is one store. The exact CLI/env switch has to be
  checked against the installed Claude Code before implementation. If none exists, the import
  re-runs per new session and merges by key.

### 2.2 Short sessions by default

* **The rule.** A manager turn resumes its session only when all three hold:
  * the last request was **under 55 minutes ago**, so the cache is still warm (it lasts 1 hour);
  * the context after the last turn is **under 120k tokens**;
  * the session is **under 12 hours old**.

  Otherwise the turn starts a new session. This matters because a resume after more than 1 hour
  re-writes the whole history anyway, so starting over is strictly cheaper than resuming: the
  9.5-hour gap cost $7.54 in cache writes for a context that is 5% useful.
* **Watch and job turns** always start fresh: they are 4 hours or more apart, so they are cold
  anyway.
* **What a new session starts from** (`sessionPreamble`, computed by cezar, ≤ 3k tokens):
  1. memory (§2.1);
  2. live state:
     * open question and approval cards with their ids;
     * followed tasks that are not finished, plus finished ones the user has not seen yet (one
       line each: ref, status, title, PR);
     * the open PRs the manager is tracking;
     * notes since the last turn;
  3. the last 3 user↔manager exchanges, trimmed to 2k characters, so "yes, do that" still lands;
  4. one line naming the history command.

  The current `recapPrompt` (the last 20 messages, 12k characters, used only when a resume
  fails) is replaced by this.
* **History on demand:** `cez-manager history [--since <iso|2h|1d>] [--grep <text>]
  [--limit 20]` reads `chat.ndjson` and prints compact `at  role  text` lines, capped at 8k
  characters. `cez-manager task <run>` already gives a task's detail. The system prompt tells
  the manager to look things up rather than guess.
* **The user's chat stays one continuous thread.** Sessions are an engine detail. A thin
  "new session" divider, visible only in the debug view, is optional.
* **What must survive a rotation:**
  * memory;
  * open cards and their ids (so `CEZ:ASK-CLOSE` still works);
  * followed tasks;
  * tracked PRs;
  * pending followups;
  * the turn kind;
  * message ids, for `--from-message`.

  Each of these comes from cezar state, not from the transcript. A test pins every item.
* **Transitions** (AGENTS.md § Changing a mechanism): rotation adds no new state. A session ends
  when the rule says so, and the next turn always has a valid exit: either a resume or a fresh
  start. A failed fresh start falls back to the existing retry plan.

### 2.3 Keep work in tasks, and measure it

Every manager turn records the following in the plan ledger's `messages[]` (additive fields):
* requests;
* context at the first and the peak request;
* cache read and write tokens, and output tokens;
* `cold` (true when the cache write exceeds 50% of the context);
* idle gap;
* the session id and the turn's index in it;
* the turn kind (chat, followup, watch or job);
* tool calls split into **route** (task create/say/follow, merge, proposals), **look**
  (cez-manager reads, history) and **own work** (gh, Read, Grep, Bash other).

The **popover** (PR #2363) gains:
* a "Largest turns" list with a reason chip: *cold start*, *large context*, *many requests* or
  *big tool output*;
* for the window, a small breakdown: routing vs own-work cost, and average context per turn.

A turn with ≥ 6 requests or ≥ 4 own-work calls is flagged "could be a task". The flag counts are
the evidence for whether managers should do more themselves, so the decision rests on data.

Also: fix `costUsd` to be the turn's delta (§1.5).

### 2.4 Quick wins

1. **No unusable connectors.** A Claude manager turn passes `--strict-mcp-config` with an
   `--mcp-config` holding only the servers the manager has granted tools on. If no granted tool
   is a claude.ai connector, the turn also turns claude.ai connectors off (the env/flag name has
   to be checked against the installed CLI). The Connectors settings page still discovers
   servers: a discovery-only turn, or the existing observed list, keeps showing them.
2. **Smaller `cez-manager` output.**
   * `attention` and `status` hide finished tasks older than the manager's last turn by default.
     `--all` shows them.
   * `--compact` (the default for managers) prints `kind ref title` per line.
   * Any command's output is capped at 8k characters, with a "N more, use --all/--project" tail.
   * `tasks` lists active tasks plus the 20 most recent finished ones.
3. **Less repeated boilerplate.**
   * The follow-up rules ("Act on it now…", 1.1k characters) move into the system prompt once.
     The wake message keeps one line.
   * The open-questions list is sent only when it changed since the last turn. Otherwise it
     becomes "Open questions unchanged (N)".
   * Followed-task reports carry the status line and headline, plus `cez-manager task <run>`
     for the full final message. The fence stays.

## 3. Ranked options and estimated savings

Replayed on the 266 real requests of session `2fd8a2fe`. Each replay keeps the same output and
turns, changes only the context, and re-applies the 1-hour cache rule. Baseline: **$52.05**.

| # | Option | Replayed cost | Saving | Notes |
|---|---|---|---|---|
| 1 | **Short sessions + memory + live state** (55-min idle / 100k cap, connectors gone) | $15.4 | **−70%** | 16 sessions instead of 1. Cold starts cost ≈ $0.3, not $7–8 |
| 1b | Same, but a fresh session on every wake | $9.7 | −81% | Loses warm-cache reuse within a thread; the follow-up quality risk is higher |
| 2 | **No denied connectors** (alone, endless session) | $25.9 | −50% | The fastest single win. In a short session it still saves ≈ 3–4k tokens per turn |
| 3 | Less boilerplate (alone) | $50.0 | −4% | Grows with session length; small in short sessions |
| 4 | Finished tasks hidden + output caps (alone) | $51.1 | −2% | Protects against a single 30k-character answer |
| 2+3+4 | All quick wins, endless session | $22.9 | −56% | |
| 5 | Instrumentation | — | — | Explains the next spike; finds work that should be a task |

Watch session: one fresh session per check costs ≈ $0.4, against an average of ≈ $1.65 on the last
four checks (≈ −70%).

In plan terms, using the ledger's own pp-per-dollar on this account: the 5 pp reply becomes
≈ 0.3–0.5 pp, and an ordinary turn drops from ≈ 0.95 pp to ≈ 0.1–0.3 pp.

**Trade-offs.**
* A new session has not *seen* the last discussion. It relies on memory, live state, the last 3
  exchanges and `history`. That risk is mitigated by the survival list and tests, and the cap
  is configurable.
* `--strict-mcp-config` also drops the user's own MCP servers (DaVinci, e2e, telemetry). A
  manager uses only the ones it was granted, which is the point of the change.
* Memory writes go through a CLI command: one extra tool call when the user says "remember…".

## 4. Recommendation

Ship in this order:
1. **Quick win 1** (connectors), together with the **costUsd fix** and the per-turn fields
   (§2.3, server side). Small, safe, and halves the cost today.
2. **Short sessions with cezar memory** (§2.1 + §2.2), including the Claude auto-memory import
   and the history command.
3. Quick wins 2 and 3 and the popover additions.

Expected result: ≈ −70% manager plan use, and no single reply above ≈ 0.5 pp.

## 5. Open decisions for the owner

1. Which options go in, and in what order.
2. The session rule: 55-min idle + 100k cap (recommended), or a fresh session on every wake.
3. Memory budget: 40 entries / 6 KB (recommended), or smaller.
4. Who writes memory: the manager and the user (recommended), or the user only, with the manager
   proposing entries.
