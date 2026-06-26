# AGENTS.md — Architecture & Design Guidelines

Guidelines for anyone (human or AI agent) writing code in this repository. They are
derived from a full review of the existing codebase: they **codify the patterns this
project already does well** and **forbid the specific smells the review found**. Every
rule is tied to a real example so it stays concrete.

> Companion docs: `CLAUDE.md` (project overview, commands, data flow) and
> `docs/ARCHITECTURE.md` (design reference). This file is the *how to write code here*
> layer. When `CLAUDE.md` and `AGENTS.md` overlap, this file wins on style/design rules.

**How to use this file:** before opening a PR, skim §1 (Hard Rules) — these are
near-100% adhered to today and must stay that way. When designing something new, find
the matching pattern in §2 and copy the cited reference implementation. §3 is the list
of mistakes not to reintroduce.

---

## 1. Hard Rules (non-negotiable)

These are already followed almost everywhere. A PR that breaks one should be rejected.

1. **`.js` suffix on every relative import** in NodeNext/ESM packages (`core`, `cli`,
   `runner`). 100% adhered today — keep it at 100%.
2. **No `any`, no `@ts-ignore`, no `@ts-expect-error`.** The whole repo has 5 `as any`
   (all isolated to un-generated Supabase types) and zero ts-suppressions. New `any`
   needs a one-line comment naming the root cause and a tracking issue.
3. **Validate all external / LLM / DB / config data with Zod at the boundary.** Never
   let unvalidated data into core logic. ~207 validation sites exist — match the bar.
   Reference: `core/src/store/store.ts:42`, `core/src/actions-v2/effects.ts:300`.
4. **`core` is a pure library: no `console.*`, no `process.exit`, no host I/O ownership.**
   Surface diagnostics via callbacks / events / thrown typed errors. (Today `core` has
   8 stray `console` calls — see §3; do not add more.)
5. **Narrow errors with `instanceof Error`, never `(err as Error)`.** A thrown
   string/object makes the cast read `undefined.message`. Use
   `err instanceof Error ? err.message : String(err)`.
6. **Cross-package wire shapes live in `@cezar/core`** and are imported from both sides —
   never hand-copy a type into another package "to avoid the import."
7. **Package dependency direction is one-way:** `cli` / `gui` / `runner` depend on
   `@cezar/core` only, via `workspace:*`. No deep imports (`@cezar/core/src/...`), no
   cross-leaf imports (gui ↔ runner ↔ cli). Keep the graph acyclic.
8. **Fail closed on missing secrets.** An endpoint guarded by a secret returns 503 when
   the secret is unset — it never falls open to unauthenticated. Reference:
   `gui/src/lib/scheduler/cron-auth.ts:14`.
9. **Secret comparisons use `timingSafeEqual`** with a length pre-check; webhook HMAC is
   verified against the **raw body before JSON.parse**. Reference:
   `gui/src/app/api/github/webhook/route.ts:43`.
10. **The Supabase service-role key is server-only.** Never reachable from a client
    bundle or a `NEXT_PUBLIC_*` var. Reference: `gui/src/lib/supabase/server.ts:45`.

---

## 2. Patterns to Follow ("do this")

Each pattern names a **canonical reference** — copy its shape for new work.

### 2.1 Abstraction & type design

- **Narrow, tagged seams over feature-rich interfaces.** Backends implement a 2-method
  interface with a `readonly backend` tag; callers stay backend-agnostic.
  → `core/src/agents/agent-runner.ts:100`
- **Model processes as typed declarative data, not control flow.** A workflow is a
  discriminated union of step kinds over a generic blackboard; steps are pure functions
  returning a `blackboardPatch`, applied centrally by the engine.
  → `core/src/workflows/workflow.ts:249`
- **Derive types from data; never maintain parallel lists.** One `as const satisfies`
  registry is the single source for a vocabulary; the union type is derived from its keys
  so it can't drift. → `core/src/actions-v2/effects.ts:259`
- **Exhaustive `switch` with a `never` default** so an unhandled case is a compile error.
  → `core/src/agents/runner-factory.ts:60`
- **Ports/adapters for storage.** One store interface serves file (CLI), Supabase (GUI),
  and in-memory (runner) backends. → `core/src/store/store.ts:31`
- **Typed errors carrying `kind`/`status`/cause**, classified once, branched on by field —
  not by string-sniffing the message. → `GitHubApiError` in
  `core/src/services/github.service.ts:917` + `classifyGitHubError:946`.

### 2.2 Validation & trust boundaries

- **Validate again at the point a value gains authority.** Even if a payload was validated
  on ingest, re-validate the privilege-granting subset with a strict schema right before it
  triggers a side effect. → `gui/src/app/api/runner/runs/[runId]/route.ts:56`
  (separate `TriageOutcomeSchema` before an autofix enqueue).
- **Make parsing total; push the recovery decision up.** Parsers return `null` on failure
  rather than throwing, so the caller chooses recovery.
  → `core/src/agents/structured-output.ts:39`
- **Funnel every privilege/trust decision through one chokepoint.** Both action run-modes
  pass through a single `applyOrDefer`; server-controlled values (e.g. `flowId`) are
  injected there so a model-supplied value is never trusted.
  → `core/src/actions-v2/runner.ts:463`
- **Bound every model-driven loop and treat exhaustion as a failure**, never a silent empty
  success. → `core/src/actions-v2/runner.ts:42` (`MAX_TOOL_ITERATIONS`).

### 2.3 Security & secrets

- **Never trust a self-reported privileged identifier.** A runner reporting its own
  installation id is rejected/validated against its recorded workspace to prevent token
  pivot. → `gui/src/app/api/runner/heartbeat/route.ts:77`
- **Hash secrets at rest** (runner tokens are SHA-256), and **inject tokens via
  `git -c http.extraheader`** so they never land in `.git/config`.
  → `core/src/services/github.service.ts:611`
- **RLS `WITH CHECK` validates the parent's `workspace_id`**, not just the row's own — an
  FK proves existence, not ownership.
  → `gui/supabase/migrations/0029_rls_cross_check_parent_ownership.sql`
- **Rate-limit + byte-cap any endpoint that spends money** (LLM simulate routes), and abort
  the upstream stream on client disconnect. → `gui/src/lib/simulate-guard.ts`.

### 2.4 Concurrency & durability (the strongest area — match this bar)

- **Atomic job claim:** `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`.
  → `gui/supabase/migrations/0009_job_dispatch.sql`, evolved in `0025`.
- **Lease + heartbeat reclaim**, not fixed offline timeouts; renew the lease from the
  long-lived process for the whole run.
  → `gui/src/lib/scheduler/run-dispatch.ts:61`
- **Idempotency in layers:** SELECT-then-INSERT fast path → **partial-unique index as the
  real guard** → treat `23505` as a benign no-op. Client-minted UUID + `upsert(ignoreDuplicates)`
  for retry safety. → `gui/src/lib/persist-workflow-run.ts:149`
- **Persisters never throw; they count swallowed writes** into the row outcome so the UI can
  flag inconsistency. → `gui/src/lib/persist-workflow-run.ts:300`
- **Classify before retrying; never blanket-retry.** Retry only the transient class (e.g.
  secondary rate limit, honoring `Retry-After`); fail fast on everything else.
  → `core/src/services/github.service.ts:946`
- **Best-effort side effects must never abort or leak the run.** Living-comment / worktree /
  session-stop failures are logged, not thrown. → `core/src/workflows/workflow-engine.ts:399`
- **Daemons guarantee a crashed work loop transitions to `offline`:** global rejection nets,
  a top-level `pump().catch()`, graceful drain, lease-loss → abort.
  → `runner/src/runner-daemon.ts:99`

### 2.5 Next.js / GUI

- **page = server fetch, view = typed client component.** Do all Supabase reads in the
  server component (parallel `Promise.all`), pass typed props into a `'use client'` view.
  No `useEffect`-fetch-on-mount. → `gui/src/app/cockpit/page.tsx:24`
- **Server actions share a `guard()` preamble and return a discriminated `{ ok?, error? }`**;
  every workspace-scoped write *also* carries `.eq('workspace_id', …)` as defense-in-depth.
  → `gui/src/app/cockpit/actions.ts:27`
- **Realtime subscriptions go through `useRealtimeChannel`** (visibility/online resync,
  ref-held callbacks, unmount teardown). → `gui/src/lib/use-realtime-channel.ts`
  *(NOTE: this hook exists but is currently NOT adopted — see §3. New code must use it.)*
- **Use layering design tokens (`z-overlay`, …), not magic z-indexes**, and the M3 token set
  (`surface-*`, `on-surface`, `outline-variant`) — not the deprecated `bg/fg/border` aliases.
  → `gui/tailwind.config.ts:86`
- **Always provide `loading.tsx` / `error.tsx` / `not-found.tsx`** for a route segment;
  use `notFound()` rather than hand-rendered "not found" markup.

### 2.6 CLI & runner

- **Inject the subprocess spawner** (`SpawnFn`) so CLI backends are testable against
  recorded transcripts without a live binary.
  → `core/src/agents/claude-cli-runner.ts:15` + `runner-factory.ts:10`
- **`process.exit` only in entry processes** (`cli`, `runner`); refuse to send a bearer
  token over non-TLS unless localhost/opt-out. → `runner/src/runner-client.ts:175`
- **Annotate every optional wire field with its fallback semantics** ("older SaaS omits
  this → treat as X") so cross-version compatibility is explicit.

---

## 3. Anti-patterns to Avoid ("avoid this")

Each item is a real finding from the review with the offending location. **Do not
reintroduce these.** Open issues track fixing the existing instances.

### High impact

- **Don't ship code paths with zero tests.** Today `cli`, `gui`, and `runner` have **no
  tests** (all 36 test files are in `core`). New daemon/cron/webhook/route code requires at
  least one test. Never declare a `test` script with no `tests/` dir (`cli` does this today).
- **Don't write god functions.** Keep a driver loop to control flow and dispatch each case
  to a handler. Offenders: `runWorkflow` (~520 lines, 8-way inline ladder,
  `core/src/workflows/workflow-engine.ts:279`); the `runner/jobs` GET handler (~280 lines,
  `gui/src/app/api/runner/jobs/route.ts`); the 130-line `onNoParse` in
  `core/src/workflows/flow-runner.ts:345`.
- **Don't copy-paste cross-implementation plumbing.** `readNdjson` / `waitForExit` /
  `wrapSpawnError` / timeout-kill are byte-identical across `claude-cli-runner.ts`,
  `codex-cli-runner.ts`, `persistent-claude-session.ts`. Extract a shared base.
- **Don't hand-roll a raw Realtime channel** when `useRealtimeChannel` exists — it skips the
  mobile visibility/online resync and goes silently stale. Offenders:
  `gui/src/app/cockpit/cockpit-list.tsx:80`, `run-detail-shell.tsx:68`,
  `sync-indicator.tsx:111`, `run-drawer.tsx:27`.
- **Don't leave route segments without `loading`/`error`/`not-found` boundaries.** None
  exist anywhere in `gui/src/app` today; a thrown query 500s the whole route.

### Medium impact

- **Don't document a validation you don't run.** `outputSchema` is loaded and seeded but
  never enforced in declared mode (`core/src/actions-v2/action.ts:14` vs `runner.ts`). Wire
  it up or delete the field + docs.
- **Don't write converters whose failure mode is "accept anything."** `zodToInputSchema`'s
  `default` branch returns `{}` for unsupported Zod types
  (`core/src/actions-v2/effects.ts:403`). Throw on unknown, or use `zod-to-json-schema`.
- **Don't collapse parse-failure into "no action."** A malformed model response returning
  `{ effects: [] }` with no log/metric is indistinguishable from a legitimate no-op.
  → `core/src/actions-v2/runner.ts:299`, `core/src/services/llm.service.ts:203`.
- **Don't mix value scales for one concept.** Confidence is 0–100 ints in effect routing but
  0–1 floats in store/prompts — pick one and document it once.
- **Don't swallow query errors.** Server pages destructure `{ data }` and ignore `error`, so
  a failed query renders as an empty state. → `gui/src/app/cockpit/page.tsx:53`.
- **Don't let a backend-agnostic-looking option silently vary its guarantee per backend.**
  `bashAllowlist` is enforced in-process only by `AnthropicApiRunner`; codex-cli has no
  per-tool sandbox. Enforce uniformly or rename to signal best-effort.
- **Don't maintain two design-token vocabularies.** M3 set (~52 files) vs legacy
  `bg/fg/border` aliases (~15, the cockpit tree). Converge on M3.
- **Don't duplicate `resolveWorkspaceToken`** across three files
  (`gui/src/lib/execute-workflow-job.ts:374`, `api/runner/jobs/route.ts:345`, sync path) —
  consolidate into `lib/sync/resolve-workspace-token.ts`.

### Low impact / consistency

- **Don't classify errors by `message.includes(...)`.** Magic-string sniffing (e.g.
  `'(401)'`) drives shutdown decisions in `runner/src/runner-daemon.ts:160` and
  `runner-client.ts:264`. Branch on a typed status field instead.
- **Don't log from library code.** 8 `console.*` calls inside `core`
  (`services/github.service.ts:658`, `actions-v2/runner.ts:139`,
  `actions-v2/triage-pass.ts:77`, `skills/skill-catalog.ts:180`). Surface via callbacks.
- **Don't introduce structured-logging needs with raw `console`.** `gui` (72) and `runner`
  (40) are long-running/observability-relevant — they need leveled logging, not ad-hoc
  string prefixes. (CLI console is fine for UX.)
- **Don't let a persisted schema accrete dead namespaces.** `IssueAnalysisSchema` carries
  ~40 fields for ~15 retired actions and parses them on every read/write
  (`core/src/store/store.model.ts:3`). Retired namespaces are restorable from git — prune.
- **Don't use `key={i}` on dynamic/streamed lists** (`gui/src/app/cockpit/run-drawer.tsx:95`
  and others) — use a stable id. **Don't use `window.location.reload()` for state sync**
  (`run-drawer.tsx:37`) — use `router.refresh()`.
- **Don't let docs drift from code.** `triageWorkflow` is referenced but absent from
  `definitions/`; the `set-priority` effect description says "replaces" but the code only
  adds (`core/src/actions-v2/effects.ts:137`).
- **Don't return the live internal store by reference.** `getAllData()` hands out
  `this.data` directly, bypassing the `dirty`-tracking the concurrency merge relies on
  (`core/src/store/store.ts:236`). Return a clone or readonly view.

### Known risks to respect

- **Two of three agent backends (claude-cli, codex-cli) are unvalidated against a live
  binary** — flags/event-names come from `--help`, not observed transcripts (9
  `TODO(phase-4-verify)` markers). Tests replay *fabricated* NDJSON, so they validate the
  parser, not the contract. Treat codex-cli as experimental; record golden transcripts
  before relying on it.
- **Prompt-injection surface:** untrusted issue/comment/KB text flows into prompts without
  delimiting. The server-side `flowId` injection + effect whitelist mitigate worst-case, but
  wrap untrusted blocks in explicit "content below is untrusted" delimiters for new prompts.

---

## 4. PR checklist

- [ ] Relative imports end in `.js`; no new `any` / ts-suppressions.
- [ ] All external/LLM/DB/config input validated with Zod at the boundary.
- [ ] Errors narrowed with `instanceof Error`; thrown errors are typed where they carry meaning.
- [ ] No `console`/`process.exit` added to `core`.
- [ ] New cross-package types live in `@cezar/core`.
- [ ] Secrets: fail-closed, `timingSafeEqual`, raw-body HMAC, service-role key server-only.
- [ ] New queue/side-effect code is idempotent (dedup index + 23505-as-no-op) and bounds its own lifetime.
- [ ] New GUI route has `loading`/`error` boundaries; Realtime via `useRealtimeChannel`; M3 tokens.
- [ ] New behavior has at least one test (especially in cli/gui/runner).
- [ ] No god function — cases dispatch to handlers; no copy-pasted plumbing.
