# Agentic e2e checks: isolated credentials, run context, and pull-request heads

Status: proposed · Base: `main` @ `05471fd` (2026-10-05, #1265) · Related: `docs/e2e-verification.md`,
`.ai/specs/2026-09-14-automations-redesign.md`, `.ai/specs/2026-09-18-jira-linear-tracker-browsing.md`,
`.ai/specs/2026-08-10-task-pr-reference-list.md`

## Goal

Make an agentic e2e runner ([`tester-army/e2e`](https://github.com/tester-army/e2e), or any check that needs
a model credential) a first-class verification step in two places:

1. **Inside a task, before the review gate.** Already works since #1265 (`onFail.retryOn`). This spec fixes how
   the check gets its model credential, and what it knows about the run.
2. **On an existing pull request.** A `pull_request.*` automation launches a run whose worktree is the PR's head,
   runs the e2e check against it, and reports back. Today such a run tests the base branch, not the PR.

Throughout, cezar keeps its existing stance on credentials: it never owns, ships, proxies or pools a model
credential. A check's credential is the project owner's own key, stored on their machine, handed to the one
process that needs it.

## Current state (evidence)

All references are to `main` @ `05471fd`.

- **Check steps inherit the full server env.** `RunManager.runCheckStep` spawns
  `bash -lc <command>` with `env: process.env` (`packages/cezar/src/workflows/run.ts` ~5530). There is no
  per-step and no per-project env. `docs/e2e-verification.md` therefore tells users to "export the model
  credential your provider reads (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, …) before starting cezar".
- **That advice leaks the key into agent sessions.** Agents get a curated env from `buildChildEnv`
  (`core/agent-env.ts`), and the curation is prefix-based: `claude: ['ANTHROPIC_', 'CLAUDE_']`,
  `codex: ['OPENAI_', 'CODEX_', 'AZURE_OPENAI_']`, and `MULTI_PROVIDER_PREFIXES` for opencode and pi
  (`OPENAI_`, `ANTHROPIC_`, `OPENROUTER_`, …). An `ANTHROPIC_API_KEY` exported for e2e is passed to every
  Claude Code session cezar starts. Claude Code then authenticates with the API key instead of the user's
  subscription account selected in Agent accounts. The effect is a silent billing switch, and it bypasses the
  account the user chose. The same holds for `OPENAI_API_KEY` and Codex.
- **Check output reaches the next agent prompt unredacted.** Events are scrubbed in `RunStore.appendEvent`
  (host secrets from `collectSecretValues` plus `registerRunSecrets`, plus `TOKEN_PATTERNS`). The retry prompt
  is not: `checkFailure = output` (~4254) is appended raw to `userPrompt` (~4412) and sent to the agent's
  model provider.
- **Automation placeholders do not reach check steps.** `renderAutomationTask` substitutes
  `{{github.number}}` and friends in the task prompt only (`automations/task-template.ts`). A check `command`
  cannot know which PR it is verifying.
- **PR automations fork from the base branch.** `launchAutomationRun` → `startRun` → worktree base from
  `chooseForkBase(repoRoot, repo.branch, config.baseBranch)` (`run.ts` ~4043). `StartRunInput` has no ref
  field. The `GithubCandidate` comes from `/search/issues` and carries no head repo, ref or sha
  (`automations/github-poller.ts`).
- **The replay cache is cold in every worktree.** `e2e init` adds `.e2e/cache/` to `.gitignore`, and each task
  starts in a fresh worktree, so every `agent.act` step calls the model on every task. Not a cezar bug, but
  cezar can offer a shared directory.
- **Precedent for project-scoped secrets exists.** Tracker credentials live in
  `~/.cezar/tracker-connections/` (`server/tracker/connections.ts`): `0600` files, atomic tmp/rename writes,
  `assertCezarHomeWriteIsSandboxed`, and values registered via `registerRunSecrets` before spawn
  (`run.ts` ~1218).

## Non-goals

- A post-`create-pr` hook. `POST /runs/:id/pr` is reachable only after the review gate, and check steps run
  before it, so a check already gates publication. A hook after publication adds a second, weaker gate.
- Replacing GitHub Actions. For teams that run CI, `.github/workflows/e2e.yml` with `@e2e-dev/github` is the
  recommended "on every PR" path and is documented, not built (see Docs).
- Pushing fixes onto someone else's PR branch. A PR-head run that changes code cannot be published in v1 (see
  Phase 3).
- Subscription/OAuth logins for check tools (`npx e2e login …`). Documented as unsupported for unattended runs.
- Any e2e-specific code in the engine. Everything here is generic to check steps.

## Design

### Phase 1: project check credentials (`check-env`)

**Storage.** New store `CheckEnv` in `packages/cezar/src/workspace/check-env.ts`, one file per project at
`~/.cezar/check-env/<projectId>.env`. Same write discipline as `TrackerConnections`: directory `0700` with a
`*` `.gitignore`, files `0600`, `O_NOFOLLOW` reads, atomic tmp/rename writes, `assertCezarHomeWriteIsSandboxed`,
every path through `cezarHomeDir()`. Format is `NAME=value` lines; no interpolation, no `export`, no quotes
processing beyond a single optional pair of surrounding quotes.

**Names.** `^[A-Z_][A-Z0-9_]{0,127}$`. Refused: anything starting with `CEZ_`, and `PATH`, `HOME`, `SHELL`,
`USER`, `TMPDIR`, `TEMP`, `TMP`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `BASH_ENV`, `ENV`.
A refused name is a 400 with the reason, never a silent drop.

**Injection.** `runCheckStep` builds `env = { ...process.env, ...checkEnv, ...runContextEnv }` (Phase 2 wins
last). `checkEnv` is resolved once per check execution, so an edit takes effect on the next check, not
mid-command. Agent steps are untouched: `check-env` values are never in `process.env`, so `buildChildEnv` cannot
pass them to a backend by prefix.

**Redaction.** Before the check spawns, `store.registerRunSecrets(runId, Object.values(checkEnv))`. After it
exits, both uses of the output go through redaction:

- `emit('check-output')` is already redacted by `appendEvent`; no change.
- `checkFailure` is stored as `this.store.redactRunText(runId, output)`. This is a change for every workflow,
  including ones without `check-env`: host secrets and token patterns in a failing check's output no longer reach
  the agent's model provider. The change is strictly narrowing.

**API** (project-scoped family, chained, zod schemas in `packages/contract`, validators as middleware):

- `GET /api/v1/p/:project/check-env` → `{ names: string[] }`. Values are never returned, not even masked.
- `PUT /api/v1/p/:project/check-env/:name` with body `{ value: string }` (max 16 KiB) → `204`.
- `DELETE /api/v1/p/:project/check-env/:name` → `204`; `404` when absent.

Writes are gated exactly like tracker connection writes. Copy their capability check rather than inventing a
new one, and name the gate in the PR description.

**CLI.** `cez check-env list | set <NAME> | unset <NAME>`. `set` reads the value from stdin (no value in argv,
so nothing lands in shell history or `ps`), refuses a TTY echo, and prints only the name.

**Cockpit.** Settings → project → "Check credentials": a names list, an add form with a password input, and a
delete action. No reveal, no copy.

### Phase 2: run context for check steps

`runCheckStep` adds these variables (all strings; unset ones are omitted, never empty):

| Variable | Value |
| --- | --- |
| `CEZ_RUN_ID` | the run id |
| `CEZ_PROJECT_ID` | the project id |
| `CEZ_WORKTREE` | absolute worktree path (equals `cwd`) |
| `CEZ_BRANCH` | the run's branch |
| `CEZ_BASE` | the recorded fork point (`run.baseBranch`) |
| `CEZ_STEP_ID` | the check step's id |
| `CEZ_ATTEMPT` | 1-based attempt number of this check within the run |
| `CEZ_SHARED_CACHE_DIR` | `~/.cezar/cache/<projectId>`, created `0700` on first use |
| `CEZ_GITHUB_REPO`, `CEZ_GITHUB_NUMBER`, `CEZ_GITHUB_EVENT` | from the automation provenance, GitHub runs only |
| `CEZ_PR_HEAD_SHA`, `CEZ_PR_HEAD_REF`, `CEZ_PR_BASE_REF` | Phase 3 PR-head runs only |

`CEZ_SHARED_CACHE_DIR` is the fix for the cold replay cache. The documented e2e config is
`cache: { mode: 'read-write', dir: process.env.CEZ_SHARED_CACHE_DIR ? join(process.env.CEZ_SHARED_CACHE_DIR, 'e2e') : '.e2e/cache' }`.
Parallel tasks on different branches can overwrite each other's recordings. The cost is a re-recording (model
calls), not a wrong verdict, because e2e verifies the end state of every replay. Documented, not mitigated.

These are cezar-set outputs, not user knobs, but they are `CEZ_*` names: list them in `docs/reference.md` and add
a commented "set by cezar for check steps, do not set" block to `.env.example` in the same commit.

### Phase 3: pull-request head worktrees for automations

**Opt-in field.** `automationTaskSchema` gains

```ts
checkout: z.enum(['base', 'pr-head']).optional(),   // omitted = 'base' = today's behavior
allowForkHeads: z.boolean().optional(),              // only meaningful with 'pr-head'; default false
```

Both are accepted only on `kind: 'github'` definitions whose `events` are all `pull_request.*`. Otherwise a
load-time error names the field. Existing definitions are unchanged. This is a new capability, not a replacement:
PR-review automations that run `gh pr checkout` themselves keep working byte-for-byte.

**Resolution at launch.** In `launchAutomationRun`, when `checkout === 'pr-head'`:

1. `gh api repos/{owner}/{repo}/pulls/{number}` → `head.sha`, `head.ref`, `head.repo.full_name`, `base.ref`,
   `state`, parsed with a zod schema.
2. `state !== 'open'` → no run; the receipt records `skipped: pr-not-open`.
3. `head.repo.full_name !== repo` and `!allowForkHeads` → no run; receipt `skipped: fork-head`.
4. `git fetch origin +refs/pull/{number}/head:refs/cezar/pr/{number}`. Use a namespaced ref, never a branch, so
   nothing appears in the user's branch list.
5. Fetched sha differs from `head.sha` → proceed with the fetched sha and add a note event (the PR moved between
   poll and launch). The fetched sha is what is tested and what is recorded.
6. `startRun` with a new internal `StartRunInput.forkRef = { sha, label: 'pr/{number}' }`. In `execute`,
   `forkRef` takes precedence over `chooseForkBase`. `run.baseBranch` records the sha, so diffs and shortstats
   measure only what this run changed on top of the PR.

`forkRef` is not added to the `POST /runs` contract in v1. It is reachable only from automations.

**Fork heads are untrusted code.** When `allowForkHeads` admits a fork, the run is marked `untrustedHead: true`
on the run record (contract field, optional, `.catch(undefined)` for old records). For such runs `runCheckStep`
does not inject `check-env` and does not register its values. The check runs with the server env only, and the
docs say that a fork check therefore gets no model credential. This mirrors GitHub Actions withholding secrets
from fork PRs and the e2e security model ("run untrusted pull request code in an external sandbox without
secrets"). Running untrusted heads in an Open Mercato sandbox is a follow-up, not v1.

**Linking.** The PR is attached as the run's referenced pull request through the existing reference mechanism
(spec `2026-08-10-task-pr-reference-list`), so the cockpit chip shows it.

**Publishing.** `POST /runs/:id/pr` on a run with `forkRef` returns `409 { error: 'this run verified pull
request #N; publishing its changes is not supported yet' }`. Without this, a draft PR would be opened from the
cezar branch into the default base and would contain the whole foreign PR.

**Worktree cleanup.** `refs/cezar/pr/{number}` is deleted when the last run referencing it is deleted or its
worktree removed (`removeWorktree` path). A stale ref is harmless; leaking one per PR forever is not.

### Reporting back to the PR

No engine code. The documented workflow posts a comment from the check itself:

```yaml
- id: e2e
  name: Browser e2e on PR head
  command: |
    npm ci --prefer-offline --no-audit >/dev/null
    npx e2e run --reporter list,markdown --max-failures 3; code=$?
    if [ -f .e2e/summary.md ] && [ -n "$CEZ_GITHUB_NUMBER" ]; then
      gh pr comment "$CEZ_GITHUB_NUMBER" --repo "$CEZ_GITHUB_REPO" --edit-last --create-if-none --body-file .e2e/summary.md
    fi
    exit $code
```

`--edit-last --create-if-none` keeps one comment per PR. If the installed `gh` lacks `--create-if-none`, the
docs show the two-call fallback.

## Default path, with every new knob at its shipped default

| Scenario | Before | After |
| --- | --- | --- |
| Workflow with checks, no `check-env` file | check gets `process.env` | same, plus `CEZ_*` context vars |
| Failing check output in the retry prompt | raw | redacted with host and run secrets |
| User who exported `ANTHROPIC_API_KEY` per the old docs | works, and leaks into agents | unchanged (no behavior removed); docs now steer to `check-env` |
| `pull_request.opened` automation without `checkout` | worktree from base | unchanged |
| `create-pr` on any existing run | works | unchanged; only `forkRef` runs get 409 |
| `CEZ_DRY_RUN=1` | — | `check-env` resolves normally; Phase 3 makes no `gh`/`git fetch` calls and uses a fixture PR |

No timer, lock, cap or timeout is removed. The only behavior change on the zero-config path is the redaction of
the retry prompt, which can only remove text.

## States and transitions added

A `pr-head` launch has exactly these outcomes, and each one ends somewhere:

- PR closed or merged before launch → receipt `skipped: pr-not-open`, no run.
- Fork head without `allowForkHeads` → receipt `skipped: fork-head`, no run.
- `gh api` or `git fetch` fails (network, auth, force-pushed-away ref) → no run; receipt
  `failed: pr-head-unavailable` with the git/gh stderr (redacted). Not retried automatically; the next poll does
  not re-fire for the same `eventId`.
- Run started → normal run lifecycle. A check that exits 2/3/4 with `retryOn: [1]` fails the run naming the code,
  as today.

## Resolved assumptions

| Question | Answer |
| --- | --- |
| Why not a per-step `env:` in workflow YAML? | Workflow files are committed. Secrets would end up in the repo, or the YAML would need an interpolation language. A project store keeps values off disk in the repo and off the agent. |
| Why not reuse `CEZ_ENV_PASSTHROUGH`? | It widens what agents receive. The goal is the opposite. |
| Why not put model keys into Agent accounts? | Accounts select how a coding agent authenticates. A check's credential belongs to the project, not to the agent backend, and must never reach the agent. |
| Should cezar set `E2E_TELEMETRY_FLEET` by default? | No. That is a vendor-specific default in the engine. Documented in `docs/e2e-verification.md`; users can put it in `check-env`. |
| Does a checks-only workflow work? | Must be verified by a test (below). The PR verification workflow has no agent step. If the engine requires one, fixing that is in scope for Phase 3. |

## Tests

Prove-red rule applies: for each fix test, `git stash push -- <source files>`, confirm red, `git stash pop`.

**Phase 1**

- `check-env.test.ts`: `0600` file and `0700` dir, refused names (each class), atomic write under concurrent
  writers, `GET` returns names only, `O_NOFOLLOW` refuses a symlinked file, sandbox guard trips outside `CEZ_HOME`.
- `check-env-injection.test.ts`: a check step sees `FOO` from `check-env`; the claude, codex and opencode
  `buildChildEnv` results for the same run do not contain it. Regression pin: with `ANTHROPIC_API_KEY` only in
  `check-env`, the claude agent env has no `ANTHROPIC_API_KEY`.
- `check-retry-redaction.test.ts`: a check that echoes a `check-env` value and a `sk-ant-…` token fails; the
  retried agent's prompt contains `[REDACTED]` and neither value. Red on `main`.
- Guard: no `check-env` file → check env equals `process.env` plus context vars.

**Phase 2**

- Every variable in the table is present with the right value on a worktree run; GitHub-only and PR-only
  variables are absent elsewhere (absent, not empty).
- `CEZ_SHARED_CACHE_DIR` is created `0700` and is the same path for two runs of one project, different across
  projects.

**Phase 3**

- Schema: `checkout` refused on `schedule`/`tracker` kinds and on mixed `issue.*` events.
- Launch with fixture `gh`/`git`: same-repo PR → worktree HEAD equals head sha, `run.baseBranch` equals sha,
  PR referenced on the run.
- Fork head without `allowForkHeads` → `skipped: fork-head`; with it → run starts, `untrustedHead: true`, check
  env has no `check-env` values.
- PR moved between poll and launch → fetched sha used, note event emitted.
- Closed PR → `skipped: pr-not-open`. Fetch failure → `failed: pr-head-unavailable`, no run.
- `POST /runs/:id/pr` on a `forkRef` run → 409; on a normal run → unchanged (guard).
- Checks-only workflow reaches the review gate with a correct status.
- Existing `pull_request.opened` automation without `checkout` forks from base (guard, passes on `main`).
- `CEZ_DRY_RUN=1` → no network, fixture PR used.
- `contract-parity` tests updated for `untrustedHead` and the new routes.

## Docs (same PR as the code that needs them)

- `docs/e2e-verification.md`:
  - Replace "export the model credential before starting cezar" with `cez check-env set`, and state why: a
    prefix-matched key reaches agents and switches Claude Code or Codex to API billing.
  - Add `CEZ_SHARED_CACHE_DIR` to the `e2e.config.ts` snippet.
  - Add a "Verify a pull request" section with `checkout: 'pr-head'` and the comment-posting check.
  - Add an "On every PR, in CI" section pointing to GitHub Actions with `@e2e-dev/github`, with secrets in
    repository secrets and fork PRs excluded.
  - State that check tools must use API keys or service-account keys, not subscription logins.
- `docs/reference.md`: env table for check steps, `cez check-env`, the two automation fields.
- `.env.example`: the commented `CEZ_*` check-context block.
- `CHANGELOG.md`: one entry per phase.

## Rollout

Phases ship as separate PRs in order. Phase 1 is independently valuable (it fixes the credential leak the current
docs cause) and should land first. Phase 2 is small and unblocks the docs. Phase 3 depends on both.

## Open questions

1. Should `untrustedHead` runs be routed to an Open Mercato sandbox automatically when one is configured, so
   fork PRs can be verified with a credential? Proposed: follow-up spec.
2. Should a PR-head run be allowed to push fixes back to a same-repo PR branch (instead of the 409)? Needs a
   decision on who authors the commit and whether it requires the PR author's consent.
3. Should `pull_request.synchronize` (new commits pushed) become an automation event, so verification re-runs on
   every push, not only on open? The `/search/issues` poller cannot see it; this needs the PR timeline or a
   different endpoint.
