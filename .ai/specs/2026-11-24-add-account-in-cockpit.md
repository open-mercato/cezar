# Add an agent account from the cockpit

Status: design, awaiting approval · Date: 2026-11-24 · Design page: `2026-11-24-add-account-in-cockpit.html`
Builds on: `2026-07-29-agent-profiles.md` (accounts), `2026-11-18-inline-account-reconnect.md` (login sessions)

## Problem

Adding a second Claude or Codex login means making a folder, signing in from a terminal with
`CLAUDE_CONFIG_DIR=… claude`, and then typing that folder's path into Settings → Agent accounts →
Add account. A phone can't do any of that. Since #1900, a paired phone is refused the whole accounts
family, because folder paths reveal the host's layout.

## What already exists

- **Login sessions** (#2314): `POST /api/v1/providers/login`, `…/input`, `DELETE …`, the workspace SSE `agent-login`, and
  drivers for Claude (browser via PATH shim, or paste-code), Codex (browser, device code, API key), Cursor, Copilot
  and OpenCode. Other runners fall back to the watched terminal. Verification runs `profileStatus` and reads the identity.
- **The reconnect card's signing UI**: device code with countdown, paste form whose value never enters React state,
  bottom sheet on phones, and links that open in the system browser from the phone shell.
- **Accounts** are `{id, provider, configDir, label, addedAt}` rows in `~/.cezar/agent-accounts.json`. Runners that
  can carry one: `claude` (`CLAUDE_CONFIG_DIR`), `codex` (`CODEX_HOME`), `omp` (`PI_CODING_AGENT_DIR`), `kimi`
  (`KIMI_CODE_HOME`).

## Design

**Add account** opens a three-step dialog (a full-height sheet on a phone):

1. **Agent and name.** Pick an agent that can carry accounts, then name the account. Agents that can't carry accounts
   are listed, disabled, with the reason. An *Advanced: use a folder that is already signed in* disclosure keeps today's
   path field. It is hidden on phones and on hosted cockpits.
2. **Sign in.** cezar creates a private folder and starts the vendor's own login in it. The signing body is the
   reconnect card's, so the same states apply: browser tab (local), paste the code (Claude remote), device code (Codex
   remote), API key (Codex, on request), and the terminal hand-off (OMP and Kimi: no headless login).
3. **Ready.** Shows the identity (email, organization, plan) and plan usage when the runner reports them, plus two
   optional switches: *Use for this project* and *Default for new projects*.

Failure states use the login session's fixed reasons: code expired (with *Get a new code*), rejected, exited, not
installed (with the install hint), timeout, and the hosted refusal. Two states are new:

- **Same login as an existing account**: the new identity's email matches another account of that agent. The dialog
  warns and offers *Keep both* or *Remove this one*. It never blocks, because two folders on one login is legal.
- **Cancel**: the dialog asks first, then deletes what it created.

Entry points: Settings → Agent accounts (a header button and a per-agent **+**), and "Add account…" at the end of
every account picker (task, manager, reconnect *Use another account*).

## Mechanism

**Managed folder.** `~/.cezar/agent-homes/<provider>/<id>/` (under `cezarHomeDir()`, so `CEZ_HOME` applies), mode
`0700`. The row records `configDir` as that absolute path, plus two new optional fields that older versions keep
through `.passthrough()`:

- `managed: true`: cezar made the folder, so cezar may delete it.
- `pending: true`: no sign-in has been confirmed yet. Pickers, fallback candidates and project selections skip a
  pending account, and the listing returns it so Settings can show "Signing in…".

**Routes**, all chained into the agent-profiles family and declared in the contract:

- `POST /workspace/agent-profiles` accepts `{provider, label, managed: true}` with no `configDir`. The server
  allocates the id and folder and answers the row. The existing `{provider, configDir, label}` body is unchanged.
- The client then calls the existing `POST /providers/login {provider, profileId}`. The login session's `connect` step
  clears `pending` once `confirmConnected` passes, so the row becomes usable even when the cockpit has closed.
- `DELETE /workspace/agent-profiles/:id` on a managed row first runs the CLI's own logout under the account's env
  (`claude auth logout`, `codex logout`; best-effort, bounded by a timeout), so a macOS Keychain item keyed to the folder
  doesn't outlive it. It then removes the folder, but only after a realpath check proves the folder is inside
  `agent-homes/`. An unmanaged row keeps today's behavior: the row goes and the folder stays.
- **Cancel** in step 2 cancels the login session, then deletes the pending row as above.
- **Boot sweep**: a pending managed row older than 24 hours with no live session is deleted along with its folder. A
  closed laptop lid can't leave a stray account behind.

**Per runner**

| Agent | Local cockpit | Phone or hosted | Completion |
| --- | --- | --- | --- |
| Claude Code | `claude auth login`; the browser launch is captured and opened in a tab | printed URL, then *paste the code* (stdin) | the CLI exits 0 → verify |
| Codex | `codex login` (localhost:1455 callback) | `codex login --device-auth`: code and countdown | detected automatically |
| Codex (API key) | `codex login --with-api-key` (stdin) | same | the CLI exits 0 |
| OMP, Kimi | terminal hand-off and the login watcher | `cez account login <id>`, run on the computer, then *Check again* | watcher or Check again |

`cez account login <id>` is a new, small CLI subcommand. It runs the agent's login with that account's variable set.
Because it names the account by id, the phone gets a command to copy that never reveals a host path.

`claude setup-token` is **not** used. It prints a long-lived token that cezar would then have to store. With
`auth login`, the CLI writes its own credential into the account's folder (or its Keychain item).

**Phone (relay scope).** Today `accountsEnabled()` refuses relay scope entirely. This adds a narrowed allowance:

- `GET /workspace/agent-profiles` answers in relay scope with `configDir` and `files` removed from every row.
- `POST` with `managed: true` is allowed. A client-supplied `configDir` is still refused.
- `DELETE` is allowed for managed rows only.

The phone never sends or receives a host path. The login session already strips a named account's command from a
phone's view (`phoneSafeSession`).

**Hosted web.** Unchanged gate: everything in this family needs `CEZ_REMOTE_AGENT_ACCOUNTS=1`. The managed path
never takes a client path, so `checkProfileDir`'s browse-root containment doesn't apply to it.

## Security

- Tokens never leave the vendor CLI's own store. The page gets only the phase, an allow-listed URL, a device code,
  an expiry and a fixed reason.
- A pasted code or key goes from the input element straight to the route and on to the CLI's stdin. It is never kept
  in React state, the query cache, the run store, logs or telemetry. Over the relay it travels inside the paired
  Noise tunnel, the same protection every other request gets, and nothing extra.
- The folder is `0700`. Deletion is limited by a realpath check to `agent-homes/`, so a hand-edited `configDir` can
  never make cezar delete an arbitrary folder.
- Telemetry, if any is added: provider plus outcome (`connected|cancelled|failed:<reason>`), both closed sets.
- `CEZ_DRY_RUN=1`: the mock login session plus a real managed folder under the sandboxed home.

## Decisions for the owner

1. **Placement**: a dialog wizard from Settings (A, recommended), an inline row (B), or a full page (C).
2. **Phone access**: open the path-free, managed-only subset of the accounts family to paired phones (recommended:
   yes).
3. **Removing a managed account** logs out and deletes its folder (recommended: yes, with the folder named in the
   confirm dialog).
4. **OMP and Kimi**: offer them with the terminal hand-off (recommended), or hide them until a headless login is
   verified.
