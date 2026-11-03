# Cooperating with agent-CLI errors

> Analysis spec. No code changes here; each item in § Improvements is meant to ship as its own PR.
> Related: `2026-07-22-provider-authentication.md` (the probe + gate + runtime latch),
> `2026-08-03-auto-resume-after-usage-limit.md` (the timer this spec reuses for transient failures).

## TLDR

Telemetry for service Cezar (2026-10-20 → 10-24, versions 0.16.0–0.17.0-nightly) has ~24 error
groups whose text comes from an agent CLI or its vendor rather than from cezar's code. Most of them
are real conditions on the user's side: the account is out of credit, the vendor is overloaded,
the account isn't signed in. Cezar treats nearly all of them the same way. It fails the run with
the vendor's text, offers only a generic Continue, and reports the failure as an `AgentError`.

Sorting the groups into classes shows three gaps, all on cezar's side:

1. **No transient retry.** 529 overloaded, "no response from API", "model at capacity" and the
   OAuth refresh race all say "try again in a moment". None of them retries, and none is
   classified, so `failureKind` files them as `other`.
2. **The auth patterns miss three real auth failures.** "Not logged in · Please run /login",
   Cursor's "Authentication required" and OpenCode's "Invalid credential" do not match
   `isRuntimeProviderAuthFailure`. So the provider is never latched, no "needs authorization"
   card appears, and the next run is let through to fail the same way.
3. **Probable cezar bugs.** Four groups are likely caused by cezar itself (§ Suspected cezar bugs):
   - a Continue that switches runner keeps the previous runner's provider-qualified model pin and
     hands it to `claude --model` (8e1173b1);
   - the Accounts page offers **Connect** on a CLI that isn't installed (23976d8d, 77825860,
     d655679e);
   - runs started by `recover()` or the queue skip the pre-launch provider gate (bca23063);
   - JSON error envelopes are scrubbed to `{<value>:<value>…}`, which makes three groups
     undiagnosable (36b68a95, eb4b12dc, 919887a0).

## Method

- `mcp__telemetry__get_error` for every fingerprint in the brief (full occurrences, context, versions).
- I read the runners (`core/*-runner.ts`), `core/provider-auth.ts`, `server/provider-auth-runtime.ts`,
  `server/provider-action-gate.ts`, `runs/agent-error-telemetry.ts`, `runs/failure-kind.ts`,
  `core/usage-limit.ts`, `core/model-presets.ts`, `core/model-identity.ts`, `workflows/run.ts`
  (continuation, auto-resume) and the cockpit's error cards (`task-thread/thread-items.tsx`) and
  account settings (`settings/accounts-section.tsx`, `provider-settings.tsx`).
- I ran the live classifiers on the real messages (tsx script, outside the repo). Results:

| Message (abridged) | `isRuntimeProviderAuthFailure` | `isUsageLimitMessage` | `failureKind` |
| --- | --- | --- | --- |
| Not logged in · Please run /login | **false** | false | auth (only via the Copilot pattern) |
| cursor: Authentication required… | **false** | false | auth (only via the Copilot pattern) |
| opencode: Upstream request failed: Invalid credential | **false** | false | **other** |
| Your organization has disabled Claude subscription access | false | false | other |
| API Error: 400 Identity verification is required | false | false | other |
| Credit balance is too low | false | **false** | other |
| cursor: You've hit your usage limit Get Cursor Pro… | false | true | usage_limit (no reset → reported as `usage_limit_unparsed`) |
| Selected model is at capacity | false | false | other |
| API Error: 529 Overloaded | false | false | other |
| No response from API (waited 3m) | false | false | other |
| Failed to refresh OAuth token: another Claude Code process… | false | false | other |
| There's an issue with the selected model (openai/gpt-5) | false | false | other |
| Request too large (max 32MB) | false | false | other |

  `modelConflictsWithRunner(m, 'claude')` is `false` for `openai/gpt-5.1`, `opencode/grok-code`,
  `google/gemini-2.5-pro`, `deepseek/deepseek-chat` and `composer-2.5`, and
  `normalizeModelForBackend('claude', m)` passes each one to the CLI unchanged.

## How an agent error reaches the user today

1. The runner emits v1 `error` / v2 `session.error`. `reportAgentError` scrubs the text and sends an
   `AgentError` report. The only exception is a usage limit with a readable reset, which is skipped
   and auto-resumed (spec 2026-08-03).
2. `RunManager` marks the run `failed` with `run.error` = the text. The thread shows it in red, and
   the only action is **Continue**, which resumes the same session with the same runner, model and
   account unless the user changes them in the composer.
3. Two kinds of failure get extra handling:
   - `provider-auth-required`: the runtime latch, which needs `isRuntimeProviderAuthFailure`.
     It renders a card with a sign-in action, and later launches are refused by
     `providerActionError` until the user acknowledges it.
   - `agent-update-required`: an outdated-CLI card (`isOutdatedBackendError`).
4. `task_failed` telemetry counts `failureKind` ∈ `missing_session | usage_limit | auth | timeout | other`.
5. Pre-launch, the HTTP routes that start or continue a run call `providerActionError`. It checks
   the provider is enabled and the probe says `connected`, and re-probes before it refuses.
   `RunManager.recover()`, the queue pump and auto-resume do not call it: the gate lives in
   `server.ts`, not in the engine.

## Per-group analysis

Classes: **T** transient/retryable, **A** auth/account, **Q** quota/billing, **C** config-by-cezar,
**E** environment, **V** unsupported version, **X** cezar observability/UX bug.

### Transient

**76aa46a9 — claude `API Error: 529 Overloaded`** (1 user, 0.16.1, 5 runs in flight). Class **T**.
Claude Code has already retried internally before it gives up, so this is a sustained overload,
not a single blip. *Today:* failed, generic Continue, `other`. *Should:* do one delayed automatic
Continue, a few minutes out, via the auto-resume timer (Improvement 1). Classify it as `transient`.
Send a `agent_transient_failure` event instead of an error report: there is nothing to fix in cezar.

**9dd88886 — claude `No response from API (waited 3m)`** (1 user, macOS, `app.remote`, 5 running).
Class **T/E**: a network path or proxy is holding the stream. *Today:* the same as above. *Should:*
retry the same way. After a second consecutive hit, show a hint naming the CLI's own knobs
(`API_TIMEOUT_MS`, `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`), because cezar passes the user's env through.
No probe can catch this before launch.

**a1c2fcc2 — codex `Selected model is at capacity. Please try a different model.`** Class **T**,
with a model-switch escape. *Should:* do one delayed auto-retry. Then show an actionable card,
"Model at capacity — **Continue with another model**", that opens the composer's model picker
prefilled with the runner's default (`''` = auto), so the fix is one click (Improvement 4).

**204c5e03 — claude `Failed to refresh OAuth token: another Claude Code process is refreshing it…`**
(2 users, 0.16.1, Linux and Windows). Class **T**, and partly self-inflicted. At report time
`runs.running` was 0, so the other process holding the refresh lock was not a cezar task session.
It was the user's own interactive `claude`, or one of cezar's background Claude spawns:
`claude auth status` probes, `list_models` discovery (`claude-model-catalog.ts`) and the task
namer. All of them share `~/.claude`'s credentials, and the refresh lock is per config dir.
`isDefinitiveProviderAuthFailure` already excludes this variant on purpose, so it does not latch.
That part is correct. *Should:* (a) auto-retry once after 30–60 s with jitter. (b) Before spawning
a run, wait while a cezar-owned Claude probe or discovery for the **same config dir** is still in
flight. That is a single in-process promise per profile dir and needs no lock file (Improvement 7).
Cezar cannot see the user's own interactive processes, and the retry covers them.

### Auth / account

**bca23063 — claude `Not logged in · Please run /login`** (0.17.0-nightly, macOS app,
`process.uptime_s` = 7, `runs.queued` = 1). Why didn't the probe catch it? Two reasons, both on
cezar's side:
1. **The run never passed the gate.** Seven seconds after boot, with a run queued, this is a run
   started by `recover()`/the queue pump, maybe a restart recovery or a queued run from before a
   restart. `providerActionError` lives only in the HTTP handlers (`server.ts` 4009/4818/4989/5144/…),
   and `RunManager` has no access to it. An HTTP launch would have been re-probed and refused with
   "Claude Code credentials are unavailable…".
2. **The failure is not recognized afterwards.** "Not logged in" matches no
   `RUNTIME_AUTH_FAILURE_PATTERNS` entry, so no latch, no `provider-auth-required` card, and every
   other queued Claude run starts and fails the same way. `failureKind` says `auth` only because the
   Copilot pattern happens to match.
*Should:* add the pattern (Improvement 2) and gate engine-started runs (Improvement 3).

**1e673dee — cursor `Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY`**
(1 user, 2 occurrences 90 s apart on a fresh run). Class **A**. The probe reported `connected` or
`unknown`; Cursor's `agent status` is known to be unreliable (see the `precheck` comment in
`provider-auth.ts`). *Today:* no latch, for the same pattern gap. *Should:* the auth pattern
(Improvement 2) latches it and shows the sign-in card. That also triggers the self-check, which
fixes the cached probe row.

**e41761a1 — opencode `Upstream request failed: Invalid credential`** (1 user, 6 occurrences in
about 5 min, `agent.fatal: false`). Class **A**, for the provider key configured inside OpenCode.
The occurrences come about 70 s apart: OpenCode retrying, or the user pressing Continue. *Today:*
classified `other`, no latch, and OpenCode keeps retrying. *Should:* match `invalid credential(s)`
in the auth patterns (Improvement 2). Treat it as fatal for the turn. The hint should say "the
provider key configured in OpenCode was rejected — run `opencode auth login`".

**75ae746c — claude `Your organization has disabled Claude subscription access for Claude Code`**
Class **A** (account policy). `claude auth status` still says `loggedIn: true`, so no probe can
see it. *Should:* match it in `DEFINITIVE_AUTH_FAILURE_PATTERNS`, so the self-check cannot clear
the latch. Show a card: "Your organization blocks subscription sign-in — **Use an API key** /
**Switch account**". The first action links to Settings → Agent accounts, where an `apiKeyHelper`
or `ANTHROPIC_API_KEY` account can be added. Not retryable.

**c65a5ac5 — claude `API Error: 400 Identity verification is required to continue.`** Class **A**.
The fix is vendor-side and needs a human at claude.ai. *Should:* make it a definitive auth failure
with a hint that names the vendor action ("Verify your identity at claude.ai, then Continue").
Never retry it. A warning event, not an error report.

### Quota / billing

**7d0a1d6d — claude `Credit balance is too low`** (2 users, 4 occurrences). Class **Q**: an API-key
account (Console billing), not a subscription window. `isUsageLimitMessage` misses it, so it
counts as `other`. A common trap: an `ANTHROPIC_API_KEY` in the environment overrides the
subscription login, so a user who is signed in to a subscription is billed to an empty key.
*Should:* add a `billing` failure kind (Improvement 5). The card says "API credit exhausted — add
credit, or **switch account**". When `ANTHROPIC_API_KEY` is present in the child env, it adds
"(this run used `ANTHROPIC_API_KEY` from your environment; unset it to use your subscription
login)". No auto-resume: there is no reset instant.

**5432183c — `usage_limit_unparsed`: cursor "You've hit your usage limit Get Cursor Pro…"** (2
users). Class **Q**, a plan limit with **no reset instant at all**. This is not a parser gap.
The group's own `code` field also merged in an unrelated message: a Claude-via-gateway
`503 auth_unavailable … rate_limit_error`, which is a third-party proxy's cooldown. *Should:*
(a) treat "limit with no reset" as a known outcome, not a parser gap. Report the
`usage_limit_unparsed` code only when no "upgrade/plan" phrase is present, and count the rest
under `task_failed:<runner>:usage_limit`. (b) Show a card: "Cursor usage limit — **Switch runner**
/ **Switch account**" (Improvement 4).

### Request / conversation shape

**13023969 — claude `Request too large (max 32MB). Accumulated images and attachments…`** (1 user,
Windows). Class **T-not / C-partial**. Can cezar prevent it? Mostly not, but it can recover from it.
- Cezar sends each pasted image **once**, inline with the message it belongs to.
  `continueRun`/`deliverMessage` pass only that turn's `opts.images`, and the queued stack folds
  only its own messages. Cezar does not re-send attachments on Continue.
- What accumulates is Claude Code's own conversation history: every earlier pasted image, plus
  every screenshot a tool returned (Playwright, agent-browser). Claude Code re-sends that history on
  every request. A long Design-Mode or QA task hits 32 MB without the user pasting anything large.
*Should:* (a) recognize the message and offer **Continue in a fresh session**. `ResumeFallback`
already knows how to start a fresh session and carry the user's message, and the handoff file
carries the context (Improvement 6). (b) Cheap prevention: downscale or re-encode pasted images
above a size threshold before inlining (cockpit side, `MAX_ATTACHMENTS_PER_MESSAGE` already exists
as a count cap). This is S/M, and lower priority because pasted images are rarely the bulk.

**8e1173b1 — claude `There's an issue with the selected model (<path>)…`** (2 users, 6 occurrences;
5 of them on 0.16.0 Linux, 19:22–19:51 on 10-21). The masked `<path>` means the model id contains
`/`, so it is a provider-qualified id. **This is most likely a cezar bug (config-by-cezar)**:
- Claude's model map sets `allowExplicitProvider: true, wireProviderQualified: true` so that
  gateway ids work. As a result `modelConflictsWithRunner('openai/gpt-5.1', 'claude')` is
  **false**: OpenCode's preset list is empty (#794), and the `/^gpt[-.]/` native-prefix guard
  never sees a prefixed id.
- On Continue with a runner switch, `continueRun`'s `inheritedPinIsForeign` uses exactly that
  guard. So an OpenCode pin (`openai/gpt-5.1`, `opencode/…`, `google/…`) **survives a switch to
  Claude**. `runContinuation` normalizes it, gets the same string back, and runs
  `claude --model openai/gpt-5.1`.
- Circumstantial evidence: the same 0.16.0 Linux user hit OpenCode's 405 (a58394cc, which was
  *attributed to claude*, so the run's runner had already been flipped) between 19:17 and 19:26.
  They hit this group between 19:22 and 19:51, and OpenCode `Invalid credential` at 19:51. That is
  one person alternating between OpenCode and Claude on the same tasks.
- The brief also asked about a stale catalog or workflow default. Neither fits. Cezar's Claude
  defaults are tier aliases or `auto` (no `--model`), which never contain `/`. The step path
  already drops a task model on a step whose runner differs (`run.ts` ~6793). The new-task path
  has the same weakness as Continue, though: a `POST /runs` with `runner: claude, model:
  openai/gpt-5.1` is accepted.
*Should:* Improvement 8. When the runner changes and no model is given, clear the pin unless it is
native to the target runner. Reject a provider-qualified id on `claude` unless Claude's own
discovered catalog (`claude-model-catalog.ts`) lists it or the user's settings configure a
gateway (`ANTHROPIC_BASE_URL`/`apiKeyHelper` present). Separately, the error card should offer
**Continue with the default model**.

**eb4b12dc — claude `API Error: 400 [400]: {"error":{"type":…,"message":…,"param":null,"code":null}}`**
(1 user, Windows app, 2 occurrences). The `param`/`code: null` envelope is **OpenAI-shaped**, so
Claude Code is talking to an OpenAI-compatible gateway (`ANTHROPIC_BASE_URL` → LiteLLM/OpenRouter
etc.). Class **E**, possibly **C** if the model was one cezar carried over (see 8e1173b1). The
real cause is invisible because the scrubber masks every quoted string, keys included.
*Should:* Improvement 9 (unwrap the envelope before masking). Then re-triage.

**36b68a95 — codex `{"type":"error","status":400,"error":{"type":…,"message":…}}`** (2 users,
Linux and Windows, 0.16.2). This is the Responses-API error envelope that Codex forwards verbatim
as `turn.error.message`. The usual 400s are "model not supported with a ChatGPT account" and
"unsupported parameter", both potentially **C** (a cezar-passed model or reasoning effort). The
group can't be diagnosed as reported. *Should:* Improvement 9: report and display
`invalid_request_error: <message>`, the same treatment PR #1576 gives OpenCode's envelope. Then
re-triage.

### Environment

**9cdcedc3 — codex `ENOSPC: no space left on device, write`** (1 user, Windows, 318 runs, 3 running,
`session.error` fatal). The wording is Node's, so the failed write was cezar's own: the event
NDJSON, the agent tmpdir, or a worktree file. It was minted by `UiEventSink.sessionEnded`, not by
Codex. Class **E**. *Should:* show a disk-full card naming the data dir's free space and the
cleanup actions that already exist (archive and delete old tasks, which remove worktrees and the
retention sweep). Optionally do a cheap `statfs` check before `createWorktree` and refuse with the
same message when free space is under ~500 MB (Improvement 10). Send it as a warning event.

### Unsupported version

**9f07e687 / a58394cc — OpenCode 2.x server API (HTTP 405)**. The attribution side (`codex:` /
`claude:` prefixes on an OpenCode error) is handled by the other task (branch cez/7aed76ae).
a58394cc is the pre-#1573 bare wording from 0.16.0. 9f07e687 is the named wording from 0.16.2.
Class **V**. *Today:* the probe already parses OpenCode 2.x's `auth list` rows
(`provider-auth.ts` ~283–310) and reports **connected**, so the gate lets the run through and it
dies at `POST /session`. *Should:* fail fast before launch (Improvement 11). The probe already
gets `cliVersionFrom(opencode --version)`. Major ≥ 2, or the 2.x `auth list` shape, should give
status `unsupported` (or `disconnected` with `hint` = the install-1.x message), so the gate
refuses with the actionable message. The runner picker should grey out OpenCode with
"OpenCode 2.x isn't supported yet — install 1.x". Keep the runtime 405 message as the backstop.

**919887a0 — opencode `POST /… → 500 {…}`** (0.16.1). Fix-ready in PR #1576 (still **OPEN**). It
reports OpenCode's error envelope as `<name>: <message>`. Expect a renamed successor group.
Nothing more to do here. Merging #1576 is the action, and Improvement 9 generalizes its idea.

### `ApiError` at launch: "Install X CLI, then run …"

**23976d8d (copilot) / 77825860 (codex) / d655679e (opencode)** — `POST /api/v1/providers/connect`
→ 409, from `/settings/global/accounts`, reported by the cockpit's toast handler. **This is a
cezar UX bug (X).** `provider-settings.tsx` hides **Connect** on a `not-installed` row, but
`accounts-section.tsx` renders it whenever `status !== 'connected'`, including `not-installed`.
The server then answers the expected 409 with the install hint, and a danger toast reports it
as an error. *Should:* Improvement 12. On a `not-installed` row, show "Not installed" with a
**Copy install command** button (the descriptor's `installHint` command) instead of Connect, the
way the Providers card does. Treat a `not_installed` 409 as an expected outcome and skip the
error report (`trackLoginNotOpened('not_installed')` already counts it as an event).

## Classification summary

| Fingerprint | Backend | Class | Cezar bug? | Today | Should |
| --- | --- | --- | --- | --- | --- |
| 76aa46a9 | claude | T | no | fail, `other` | delayed auto-retry; transient kind; warning event |
| 9dd88886 | claude | T/E | no | fail, `other` | auto-retry; timeout-knob hint on repeat |
| a1c2fcc2 | codex | T | no | fail, `other` | auto-retry, then "Continue with another model" |
| 204c5e03 | claude | T | partly (own Claude spawns can hold the refresh lock) | fail, `other` | retry with jitter; don't launch while own probe/discovery runs on same dir |
| bca23063 | claude | A | **yes** (engine launches skip the gate; pattern miss) | fail, no latch | latch pattern + engine-side gate |
| 1e673dee | cursor | A | pattern miss | fail, no latch | latch pattern |
| e41761a1 | opencode | A | pattern miss | fail, `other` | latch pattern, OpenCode hint |
| 75ae746c | claude | A (policy) | no | fail, `other` | definitive-auth card: API key / switch account |
| c65a5ac5 | claude | A (vendor action) | no | fail, `other` | definitive-auth card with vendor action |
| 7d0a1d6d | claude | Q (billing) | no | fail, `other` | `billing` kind; card; `ANTHROPIC_API_KEY` notice |
| 5432183c | cursor (+gateway claude) | Q, no reset | no (telemetry grouping noise) | `usage_limit_unparsed` | not a parser gap; switch runner/account card |
| 13023969 | claude | conversation size | no (cezar sends each image once) | fail | "Continue in a fresh session"; optional image downscale |
| 8e1173b1 | claude | C | **likely yes** (foreign pin survives runner switch) | fail | clear/reject foreign provider-qualified pin; "default model" action |
| eb4b12dc | claude via gateway | E/C? | unknown, masked | fail | unwrap envelope, re-triage |
| 36b68a95 | codex | C? | unknown, masked | fail | unwrap envelope, re-triage |
| 9cdcedc3 | codex (cezar write) | E | no | fail | disk-full card; optional pre-worktree statfs |
| 9f07e687, a58394cc | opencode | V | attribution yes (other task); version gate missing | fail at `POST /session` | probe marks 2.x unsupported, gate refuses |
| 919887a0 | opencode | X (masked) | fixed in open PR #1576 | — | merge #1576 |
| 23976d8d, 77825860, d655679e | copilot/codex/opencode | X | **yes** (Connect on not-installed) | 409 toast + error report | install affordance; no report |

## Suspected cezar bugs

1. **8e1173b1**: a provider-qualified model from another runner (in practice OpenCode's
   `provider/model`) survives a Continue-with-runner-switch to Claude and reaches `claude --model`.
   `modelConflictsWithRunner` returns false for every `x/y` id on Claude. Not proven, because the
   model is masked, but the guard gap is verified and the timeline fits.
2. **23976d8d / 77825860 / d655679e**: the Accounts page offers Connect on a `not-installed` CLI,
   and the expected 409 is then reported as an error.
3. **bca23063**: runs started by the engine (recovery, queue pump, auto-resume) bypass
   `providerActionError`. Separately, "Not logged in" isn't a recognized runtime auth failure, so
   it never latches.
4. **Observability bug (36b68a95, eb4b12dc, and 919887a0 before #1576)**: JSON error envelopes are
   masked key-and-value, which makes the groups undiagnosable. It hides possible further C-class
   bugs.
5. **9f07e687 / a58394cc**: wrong backend attribution (owned by the other task), plus a missing
   pre-launch version gate for OpenCode 2.x.

Everything else (76aa46a9, 9dd88886, a1c2fcc2, 204c5e03, 75ae746c, c65a5ac5, 7d0a1d6d, 5432183c,
13023969, 9cdcedc3, 1e673dee, e41761a1) originates in the vendor or the user's environment. Cezar's
share is how it classifies and reports them and what actions it offers, not the cause.

## Improvements (prioritized, each independently shippable)

Sizes: S ≈ <150 lines incl. tests, M ≈ 150–400, L > 400.

1. **Transient auto-retry (T class).** **M.** Files: new `core/transient-error.ts`
   (`isTransientAgentError`: 529/overloaded, 5xx "server-side issue", "No response from API",
   "at capacity", "another Claude Code process is refreshing", `ECONNRESET`/`ETIMEDOUT` in the
   runner text), `workflows/run.ts` (a `scheduleTransientRetry` beside
   `scheduleAutoResumeIfLimited`, reusing `armAutoResume`/`fireAutoResume` with a 2 min, then
   6 min backoff, max 2 per human turn, its own prompt and lifecycle line), `runs/failure-kind.ts`
   (`transient` kind), `runs/agent-error-telemetry.ts` (skip the error report for a transient that
   was scheduled, send a `agent_transient_failure` event instead; register it with `add_event`
   first). Same switch as auto-resume (`resources.autoResumeOnUsageLimit`, on by default), so there
   is no new knob. Applies AGENTS.md § "Changing a mechanism": the attempts counter and its reset
   on a user turn must be shared with the usage-limit path, or the two can ping-pong.
2. **Runtime auth patterns.** **S.** Files: `core/provider-auth.ts` (`RUNTIME_AUTH_FAILURE_PATTERNS`
   + `not logged in`, `authentication required`, `invalid credentials?`; `DEFINITIVE_…` + "has
   disabled Claude subscription access", "identity verification is required"),
   `core/provider-auth.test.ts` (each real telemetry message, plus negatives such as "add a test
   for the not-logged-in banner"). It latches the provider, shows the existing sign-in card, and
   stops the next run from repeating the failure. Fixes bca23063/1e673dee/e41761a1 going forward.
3. **Gate engine-started launches.** **M.** Files: `workflows/run.ts` (an injected
   `providerGate?: (required, scope) => Promise<string | null>` dependency consulted at dequeue,
   in `recover()` re-launches and in `fireAutoResume`; a refusal fails the run with the gate's
   message instead of spawning), `server/server.ts` / `server/project-context.ts` (wire
   `providerActionError` in at each `RunManager` construction site; grep the type, AGENTS.md
   "construction sites"), plus a test that a queued run against a disconnected provider is
   refused, not spawned. The test must cover the absent-gate (headless `cezar run`) case staying
   unchanged.
4. **Actionable error cards with one-click fixes.** **M.** Files: new
   `packages/contract` shape for an `agent-error-hint` event (`kind`: `model_unavailable |
   quota_no_reset | billing | conversation_too_large | disk_full | account_policy`, plus the
   suggested action), emitted by `runs/failure-kind.ts`-adjacent classification in `run.ts` on
   failure, rendered beside `ProviderAuthRequiredCard` in `task-thread/thread-items.tsx`. Actions
   open the follow-up composer preset: another model (`''`), another runner, or another account.
   No new route: the composer already accepts runner/model/account overrides (#401).
5. **`billing` failure kind and the `ANTHROPIC_API_KEY` notice.** **S.** Files: `core/usage-limit.ts`
   (do NOT add "credit balance" to `LIMIT_PHRASE_RE`, because it must never auto-resume),
   `runs/failure-kind.ts` (`billing`), and the card from item 4. The env notice comes from the run's
   child env keys (names only).
6. **"Continue in a fresh session" for `Request too large`.** **S** once item 4 exists. Files:
   `workflows/run.ts` (a continuation option `freshSession: true` that skips `--resume` and lets the
   handoff file carry context; `ResumeFallback` already has the mechanics),
   `task-thread/thread-items.tsx` action. Optional follow-up: downscale pasted images above ~2 MB
   in the cockpit before upload.
7. **Don't launch Claude while cezar's own Claude spawn holds the same config dir.** **S.** Files:
   `core/provider-auth.ts` + `core/claude-model-catalog.ts` (register in-flight probe/discovery
   promises per config dir), `core/claude-cli-runner.ts` (await that promise, capped at ~15 s,
   before spawning). The retry from item 1 covers the user's own processes.
8. **Foreign model pin on runner switch (8e1173b1).** **S.** Files: `workflows/run.ts`
   `continueRun` (on a runner change with no explicit model, clear the pin unless it is native to the
   target: a target preset, the target's native prefix, or a bare id with no `/` on Claude),
   `core/model-presets.ts` (a `modelNativeToRunner` helper), the same check in the `POST /runs`
   validation, and a regression test: Continue opencode→claude with `run.model =
   'openai/gpt-5.1'` must not spawn `--model openai/gpt-5.1`. Keep explicit gateway ids
   working when the user picks them for Claude explicitly.
9. **Unwrap JSON error envelopes.** **S.** Files: `runs/agent-error-telemetry.ts`
   (`scrubAgentErrorMessage`: when the text contains a JSON object, parse it and rewrite it as
   `<error.type>: <error.message>` before masking; keys never reach the masker), and the codex
   runner's `codexTurnError` / claude `API Error: 400 [400]: {…}` display, so the thread also
   shows the readable form. This generalizes PR #1576. Unblocks triage of 36b68a95 and eb4b12dc.
10. **Disk-full handling.** **S.** Files: `runs/failure-kind.ts` (`ENOSPC` → `disk_full`), the card
    from item 4, optional `statfs` pre-check in `git-worktree.ts:createWorktree` (refuse under
    ~500 MB free, degrade silently where `statfs` is unavailable).
11. **OpenCode 2.x fails before launch.** **S/M.** Files: `core/provider-auth.ts` (OpenCode
    descriptor: version ≥ 2 or the 2.x `auth list` shape → status `disconnected` with
    `hint: unsupportedServerMessage`, or a new `unsupported` state if the contract allows it;
    adding a state touches `packages/contract` and every switch over `ProviderConnectionState`),
    `server/provider-action-gate.ts` (refusal text = hint), runner picker greyed out in the
    cockpit. Coordinate with the attribution task on cez/7aed76ae.
12. **Accounts page: no Connect on a not-installed CLI.** **S.** Files:
    `packages/web/src/routes/settings/accounts-section.tsx` (mirror `provider-settings.tsx`:
    `not-installed` shows "Not installed" plus copy-install-command), and the cockpit's toast
    error reporting for this 409 (`lib/telemetry.ts` / the connect mutation's `onError`: don't
    report the `not_installed` refusal). Fixes 23976d8d/77825860/d655679e.
13. **Telemetry hygiene.** **S.** Files: `runs/agent-error-telemetry.ts`. Report every class
    above that has a dedicated kind (auth latched, billing, quota-no-reset, transient scheduled,
    disk-full) as a `task_failed` label or a warning-class event, not an `AgentError`. Keep
    `AgentError` for messages cezar doesn't recognize, which are exactly the ones worth a human
    look. Stop attaching `code: usage_limit_unparsed` to "upgrade your plan" limits that by
    definition have no reset.

Suggested order: **2, 12, 8, 9** first (each S, each a fix for a verified gap), then **1** (the
largest user-visible win), **3**, **4** and the cards that depend on it (**5, 6, 10**), then
**11, 7, 13**.

## Open questions

- Should a transient retry count against `MAX_AUTO_RESUMES` or have its own cap? This spec
  proposes its own cap of 2 per human turn, sharing the counter reset.
- Is `unsupported` worth a new `ProviderConnectionState` (contract change, cockpit switches), or
  is `disconnected` + hint enough? This spec leans towards the hint, which is smaller and already
  rendered everywhere.
