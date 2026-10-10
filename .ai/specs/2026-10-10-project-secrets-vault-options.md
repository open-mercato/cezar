# Project secrets: from `check-env` to a generic secret store — options analysis

Status: decided 2026-10-10 (owner: backend D with A as fallback, reworked on PR #1291's branch, workspace scope included) · Base: `main` @ `59ba4ea7` (2026-10-10) · Subject: PR #1291
(`feat/check-env`, head `715cda88`) · Related: `.ai/specs/2026-10-06-agentic-e2e-checks.md`,
`.ai/specs/2026-09-18-jira-linear-tracker-browsing.md` (§ Managed project credential storage),
`.ai/specs/2026-07-29-agent-profiles.md`

## The ask

PR #1291 adds *check credentials*: per-project `NAME=value` secrets handed to a workflow's CHECK steps
and never to an agent session. The owner wants the same mechanism to be **generic** — a project (and,
later, workspace) secret store that other consumers can draw from (an LLM key for cezar-level
"intelligent actions", future integrations) — and **safer than a plain `0600` file**, while still
letting a workflow pick the credential a check step logs in with, today.

This document separates the two halves — the *model* (what a secret is, who may read it, how a
workflow binds one) from the *storage backend* (where the bytes live) — because they are independent
decisions, and because most of PR #1291 survives either way.

## What PR #1291 is, as of its head

- **Store** `workspace/check-env.ts`: `~/.cezar/check-env/<projectId>.env`, `0700`/`0600`, `O_NOFOLLOW`,
  atomic writes, mkdir lock, `assertCezarHomeWriteIsSandboxed`, owner-root line, bounded 256 KiB read.
  A copy of the `TrackerConnections` discipline with a simpler record format.
- **Policy**: `runCheckStep` spawns with `{ ...process.env, ...checkEnv, ...context }`; every stored
  value goes to every check step of the project; values ≥ 12 chars are registered as run secrets; the
  failing check's output is redacted before it becomes the retry prompt; fork-head (`untrustedHead`)
  runs get nothing. Agent steps are untouched by construction (values never enter `process.env`).
- **Surfaces**: `GET /check-env` → names only; `PUT`/`DELETE /check-env/:name`; `cezar check-env
  list|set|unset` (value on stdin); Settings → *Check credentials*. Contract in
  `packages/contract/src/check-env.ts` (`checkEnvNameIssue`, `checkEnvValueIssue`).
- Phases 2–3 (run context `CEZ_*` vars, PR-head worktrees) are merged into the same branch.
- Review: approved by `om-auto-review-pr` (self-review, not the ruleset's human approval); `needs-qa`.
- Against today's `main` it has **one conflict**, in `packages/cezar/src/workflows/run.ts`
  (`git merge-tree origin/main pr-1291`); everything else auto-merges.

Verdict on the PR as a base: the write discipline, the never-to-agents policy, the redaction and the
API/CLI/cockpit shape are all reusable. What is *not* generic is the naming (`check-env`), the
"every value to every check step" rule, the absence of a scope/audience on a secret, and the
`NAME=value` dotenv format, which cannot carry metadata (scope, backend, created-at) without a
second file.

## What a `0600` file protects, honestly

Threats and whether a private file already answers them:

| Threat | `0600` dotenv | Notes |
| --- | --- | --- |
| Another OS user on the box | ✅ | mode bits |
| The secret landing in a repo / worktree | ✅ | lives under `~/.cezar`, `.gitignore *` |
| The secret reaching an agent session | ✅ (policy, not storage) | never in `process.env`; `buildChildEnv` cannot see it |
| Backups, dotfile sync, `tar ~`, a stolen laptop with disk unlocked | ❌ plaintext | the realistic gap |
| A same-user process (including an agent's `Bash`) reading `~/.cezar/…` | ❌ | an OS keychain closes this **on macOS only** (per-binary ACL + prompt); Linux secret-service and Windows CredMan hand the value to any same-user process |
| A secret in the process memory of cezar | ❌ | no backend fixes this |

Two neighbours set the bar: Claude Code keeps `~/.claude/.credentials.json` plaintext on Linux (Keychain on
macOS); Codex keeps `~/.codex/auth.json` plaintext; `gh` uses the OS keyring when present and falls back to
a plaintext `hosts.yml`. cezar's tracker store (spec 2026-09-18) deliberately deferred encryption with the
sentence "a store interface isolates this temporary representation so a future vault can replace it".
This analysis is that future vault's decision.

## Part 1 — the generic model (independent of backend)

```ts
interface SecretRecord {
  name: string;                 // ^[A-Z_][A-Z0-9_]{0,127}$, same refusals as checkEnvNameIssue
  scope: 'project' | 'workspace';
  audiences: Audience[];        // who may READ it; agents are never an audience
  backend: 'file' | 'keychain' | 'ref';   // where the value is (Part 2)
  ref?: string;                 // backend 'ref': an op://, bws://, env:// … locator; no value stored
  createdAt: string; updatedAt: string;
}
type Audience = 'checks' | 'cezar' | 'tracker';
```

- **Scope.** `project` secrets live with the project (`~/.cezar/secrets/<projectId>…`, owner-root
  line as in the PR). `workspace` secrets are user-wide (an LLM key for cezar's own features, shared
  by every project). Resolution for a consumer: project first, then workspace, by name.
- **Audiences, not consumers.** `checks` = a workflow check step; `cezar` = cezar's own code
  (auto-name, future "intelligent actions", automations' LLM calls); `tracker` = the Jira/Linear
  clients (migration target for `tracker-connections`, later). The list is closed and lives in the
  contract. **There is no `agent` audience and the type does not allow one** — the PR's guarantee
  becomes a type-level invariant rather than a comment.
- **Read API** (service side, never HTTP): `secrets.read(projectRoot, audience, names?)` returns
  `{ values, skipped }` exactly like `CheckEnv.read()` today, filtered by audience. HTTP keeps the
  PR's shape: names (+ metadata) out, values in, never back.
- **Workflow binding (the "pick my credentials in the workflow" part).** A check step gains an
  optional `secrets` key:

  ```yaml
  - id: e2e
    command: npx e2e run
    secrets: [E2E_GATEWAY_KEY]            # only these, by name
  - id: smoke
    command: ./smoke.sh
    secrets:                              # rename on the way in
      - name: STAGING_LOGIN_PASSWORD
        as: APP_PASSWORD
  ```

  Default when `secrets` is absent: every secret with audience `checks` (the PR's behavior, kept so
  the zero-config path is unchanged). With `secrets` present: only the listed ones, and a listed
  name that is absent produces a step `note` (`secret X not stored for this project`) rather than a
  silent empty env — the PR already has the "nothing stored stays silent" test to extend. Agent
  steps refuse the key at load time (`stepsIssue`), so YAML cannot route a secret to an agent.
- **Redaction** unchanged from the PR (register before spawn, `MIN_SECRET_LEN` floor, retry-prompt
  scrub). A `cezar`-audience read registers the value against the run that triggered it, if any.
- **Naming.** `check-env` → `secrets` everywhere: `~/.cezar/secrets/`, `/api/v1/p/:id/secrets`,
  `cezar secret list|set|unset`, Settings → *Secrets* (project) and Settings → Global → *Secrets*
  (workspace). The PR's `checkEnvNameIssue`/`checkEnvValueIssue` become `secretNameIssue`/
  `secretValueIssue` with the same rules.

Record format: one JSON file per scope holder (`<projectId>.json`, `workspace.json`), zod-validated,
`.passthrough()` per the house rules, values **inside** it only for backend `file`. The dotenv format
of the PR has no room for `audiences` or `backend` and is the one thing worth replacing before it has
users.

## Part 2 — storage backend options

Each option is judged against the repo's constraints: zero config, degrade never fail, unattended
runs (no prompt at check time), headless Linux (SSH boxes, containers — this very machine has no
`secret-tool`, no `security`, no `op`), published as a plain npm CLI, Windows.

### A. Private file, as in the PR (`0600`, atomic, owner-root)

- Works everywhere, zero deps, unattended, already written and reviewed.
- Protects against other users and the repo; does not protect the bytes at rest.
- Equivalent to what Codex and (on Linux) Claude Code and `gh` do.
- **Keep as the universal fallback regardless of what else is chosen.**

### B. OS keychain through a native binding — `@napi-rs/keyring`

- Rust `keyring` crate bound via napi; prebuilt per-platform packages (`@napi-rs/keyring-linux-x64-gnu`,
  `…-darwin-arm64`, `…-win32-x64-msvc`, …), latest 2.1.1 (published 2026-10-10). `keytar` is
  deprecated and unmaintained (last publish 2025-07); do not pick it.
- macOS Keychain (per-binary ACL — the only backend that keeps a same-user agent process from reading
  the value without a prompt), Linux secret-service over D-Bus (needs a running GNOME Keyring/KWallet
  **and** an unlocked session; absent on servers and in most containers), Windows Credential Manager.
- Cost: a native optional dependency in the published tarball (`optionalDependencies`, one ~1–2 MB
  platform package fetched on install; `test:package` must prove the CLI boots when the platform
  package is missing). First read on macOS prompts "node wants to access…" once per binary path —
  a `npx` upgrade changes the path and prompts again; cezar desktop (Tauri sidecar) is a stable path.
- Value size limits apply (Windows CredMan ≈ 2.5 KB; secret-service and Keychain are fine with 16 KiB).
- **Requires A as fallback**: with no keychain the store must still work, and the user must be told
  which backend holds a given secret (metadata `backend`, shown in Settings and `secret list`).

### C. OS keychain through the vendor CLIs (`security`, `secret-tool`, PowerShell/`cmdkey`)

- No native dependency; discovered from `PATH` like `gh`.
- `security` is always present on macOS; `secret-tool` is a separate package on Linux and useless
  without a session keyring; Windows has no clean CLI for CredMan (PowerShell + P/Invoke, or a
  third-party module) — effectively macOS-only in practice.
- One spawn per read; values cross a pipe (fine) or argv (never — `security add-generic-password -w`
  takes the value as an argument and lands it in `ps`; it has to be fed via the interactive `-w` prompt
  on stdin, which is awkward to automate).
- Strictly worse than B on every platform except "no native code"; B's platform packages already
  cover the places C would work.

### D. Encrypted file, key in the OS keychain (hybrid; what VS Code / Electron `safeStorage` do)

- `~/.cezar/secrets/<projectId>.json` holds AES-256-GCM ciphertext (Node `crypto`, no new dep for the
  cipher); one 32-byte data key per machine lives in the OS keychain (via B). No keychain → the data
  key is written to `~/.cezar/secrets/.key` at `0600`, and the store is exactly as strong as A
  (metadata records `keyBackend: 'keychain' | 'file'` so the UI can say so).
- One keychain item total (the data key), so one macOS prompt per binary, one Windows CredMan entry,
  no per-secret size limits, and the file keeps carrying the metadata (`audiences`, `scope`, `ref`).
- Rotation of the data key is a local re-encrypt; losing the keychain item (new machine, reset
  keychain) loses the secrets — acceptable and documented: secrets are per-machine by design, same as
  agent logins.
- Protects at rest (backups, syncs, disk images) on every desktop OS; adds nothing against a
  same-user process on Linux/Windows (B's caveat applies — the key is readable by the same user).
- Same optional native dep as B; same fallback story as A.

### E. References into an external secret manager (`op://`, `bws://`, `pass:`, `env://`, `sops`)

- cezar stores only a **locator**; the value is resolved at use time through the manager's CLI
  discovered on `PATH`: 1Password `op read op://vault/item/field` (service accounts give unattended
  reads via `OP_SERVICE_ACCOUNT_TOKEN`), Bitwarden Secrets Manager `bws secret get`, `pass show`,
  `sops -d`, HashiCorp `vault kv get`, Doppler/Infisical. `env://NAME` reads the cezar server's own
  env (makes today's "export before starting cezar" an explicit, auditable choice instead of a leak).
- Nothing secret ever sits in `~/.cezar`; rotation happens in the manager; teams share one source.
- Not zero-config on its own (a manager must exist and be logged in), so it is an *additional*
  backend per secret, never the only one: a secret is `file`/`keychain` **or** `ref`.
- Cost: one CLI spawn per resolution per check execution (cache for the run), a zod-validated
  adapter per manager (~40 lines each, same shape as `github.ts`'s `gh --json` boundary), and the
  manager's own failure modes surfacing as a step `note` + absent variable.

### F. Tauri desktop shell (`tauri-plugin-stronghold` / `keyring` in Rust)

- Only the desktop shell could use it, but the *server* is what spawns check steps and will run
  under `npx cezar-run` without the shell. The shell would have to proxy reads over IPC — a daemon-like
  mechanism the Zero-config section asks to avoid. Not a standalone option; B/D cover the desktop too.

### G. Passphrase-encrypted file (`age`, `gpg`, scrypt + AES)

- Needs a passphrase at read time → a prompt inside an unattended run, or a passphrase cached in
  memory/env (which is A with extra steps). Rejected for the automation path; could be offered later
  as an *export/import* format only.

## Comparison

| | A file | B keychain | C keychain CLIs | D encrypted+keychain key | E refs | G passphrase |
| --- | --- | --- | --- | --- | --- | --- |
| Zero config | ✅ | ✅ (falls back) | ⚠️ macOS only | ✅ (falls back) | ❌ needs manager | ❌ |
| Unattended runs | ✅ | ✅ | ✅ | ✅ | ✅ (service accounts) | ❌ |
| Headless Linux / containers | ✅ | ↘ A | ❌ | ↘ A | ✅ | ❌ |
| At-rest protection | ❌ | ✅ | ✅ | ✅ | ✅ (not stored) | ✅ |
| vs same-user process | ❌ | macOS ✅ / others ❌ | same | same as B | ✅ if manager prompts / ❌ with service token | ✅ |
| Carries metadata (scope, audience) | needs JSON | needs a side file | needs a side file | ✅ in file | ✅ in file | ✅ |
| New dependency | none | native optional | none | native optional | none (CLIs) | none |
| Windows | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Effort on top of PR | rename + JSON + audiences | +B adapter, +fallback, +package test | +3 adapters | +cipher, +key mgmt, +B | +adapter per manager, +ref syntax | — |

## Recommendation

1. **Model (Part 1) now**, in PR #1291 before it merges: rename `check-env` → `secrets`, JSON record
   with `scope`/`audiences`/`backend`, step-level `secrets:` binding, workspace scope. This is where
   "generic" lives; it is a rename-and-extend of code already reviewed, not a rewrite.
2. **Backend D (encrypted file, data key in the OS keychain via `@napi-rs/keyring`), with A as the
   automatic fallback.** It is the only option that is at once zero-config, unattended, metadata-bearing,
   Windows-capable and better-than-plaintext at rest, and its fallback is byte-for-byte the store the PR
   already ships. The native dep is an `optionalDependency`; `test:package` pins that the CLI boots and
   the store works with the platform package deleted. Settings and `secret list` show `keychain` vs
   `file` per machine so the degradation is never silent.
3. **Backend E (`ref`) as a follow-up PR**, starting with `env://` (free, closes the documented
   footgun explicitly) and `op://` (1Password is the common developer case and has unattended service
   accounts). Each adapter is a `gh`-style zod boundary.
4. Leave `tracker-connections` where it is; add audience `tracker` to the type now, migrate the store
   in a later PR through its existing interface (the 2026-09-18 spec planned exactly that).

What this buys the original ask: the e2e check binds `secrets: [E2E_GATEWAY_KEY]` in its workflow,
the value is encrypted at rest on a desktop and private-file on a server, the agent never sees it,
and the same store later hands an `ANTHROPIC_API_KEY`-audience-`cezar` secret to cezar's own LLM
features without touching the agents' subscription login.

## Default path, with every new knob at its shipped default

| Scenario | Before (main) | After |
| --- | --- | --- |
| Workflow with checks, nothing stored | `process.env` | same, plus `CEZ_*` context |
| Check step without `secrets:` | — | all `checks`-audience project secrets (PR behavior) |
| No keychain on the machine | — | file backend, one `note` the first time, never a failure |
| `@napi-rs/keyring` platform package absent | — | file backend, CLI boots |
| Agent step with `secrets:` in YAML | — | load-time `stepsIssue`, never a silent drop |

## Decision (2026-10-10) and what shipped

1. **Backend D with A as the automatic fallback.** `workspace/secrets.ts` encrypts each value with
   AES-256-GCM under one per-machine data key; `workspace/secret-keyring.ts` keeps that key in the
   OS keychain through `@napi-rs/keyring` (an `optionalDependency`; Linux pinned to Secret Service,
   because the library's default falls back to the kernel keyutils store, which does not survive a
   reboot) and `~/.cezar/secrets/.key` (`0600`) holds it otherwise. `GET …/secrets` and
   `cezar secrets list` report `keyBackend`. `CEZ_SECRETS_KEYCHAIN=0` forces the file.
2. **Reworked on PR #1291's branch**, before it merges: `check-env` → `secrets` everywhere (store,
   routes, CLI, cockpit, docs), JSON records with `audiences`, the step-level `secrets:` binding
   (refused on agent steps at load time), fork-head runs still get nothing.
3. **Workspace scope in the same PR**: `~/.cezar/secrets/workspace.json`, single-mount
   `/api/v1/workspace/secrets`, `cezar secrets … --workspace`, Settings → Global → Secrets.
   Audiences shipped: `checks` and `cezar` (the latter reserved: no consumer reads it yet; the
   first one resolves through `SecretStore.resolve(project, 'cezar')`). `tracker` is deferred with
   the tracker-store migration. Backend E (`op://`, `env://` references) is a follow-up.
