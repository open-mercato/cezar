# Add an agent account from the cockpit

Status: approved 2026-11-24, implemented · Date: 2026-11-24 · Design page: `2026-11-24-add-account-in-cockpit.html`
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

The existing **Add account** button (Settings → Agents → Accounts card, `accounts-add`) opens a three-step dialog
instead of the folder-path dialog. On a phone it's a full-height sheet. Settings gets no new page, nav item or button
(owner, 2026-11-24).

1. **Agent and name.** Pick an agent that can carry accounts, then name the account. Agents that can't carry accounts
   are listed, disabled, with the reason. An *Advanced: use a folder that is already signed in* disclosure keeps today's
   path field. It is hidden on phones and on hosted cockpits.
2. **Sign in.** cezar creates a private folder and starts the vendor's own login in it. The signing body is the
   reconnect card's, so the same states apply: a sign-in link (local), paste the code (Claude remote), device code
   (Codex remote), API key (Codex, on request), and the terminal hand-off (OMP and Kimi: no headless login).

**cezar never opens a browser** (owner, 2026-11-24). Every method shows the URL with **Copy link** as the main action
and *Open in default browser* as a secondary one, so the user can use the browser profile the account lives in. The
local links call back to `localhost`, so any browser on that machine completes the sign-in on its own. The CLI's own
`open` call is captured by the PATH shim only to read the URL. The reconnect card follows the same rule, so its
pre-opened tab (`pendingTab` in `use-reconnect.ts`) is removed.
3. **Ready.** Shows the identity (email, organization, plan) and plan usage when the runner reports them, plus two
   optional switches: *Use for this project* and *Default for new projects*.

Failure states use the login session's fixed reasons: code expired (with *Get a new code*), rejected, exited, not
installed (with the install hint), timeout, and the hosted refusal. Two states are new:

- **Same login as an existing account**: the new identity's email matches another account of that agent. The dialog
  warns and offers *Keep both* or *Remove this one*. It never blocks, because two folders on one login is legal.
- **Cancel**: the dialog asks first, then deletes what it created.

Other entry points open the same dialog: "Add account…" at the end of every account picker (task, manager, reconnect *Use another account*).

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
| Claude Code | `claude auth login`; the browser launch is captured and shown with Copy link (never opened) | printed URL, then *paste the code* (stdin) | the CLI exits 0 → verify |
| Codex | `codex login` (localhost:1455 callback), URL shown with Copy link | `codex login --device-auth`: code and countdown | detected automatically |
| Codex (API key) | `codex login --with-api-key` (stdin) | same | the CLI exits 0 |
| OMP, Kimi | terminal hand-off and the login watcher | finish on the computer, then *Check again* (phase 2: an in-cockpit terminal) | watcher or Check again |

`claude setup-token` is **not** used. It prints a long-lived token that cezar would then have to store. With
`auth login`, the CLI writes its own credential into the account's folder (or its Keychain item).

**Phone (relay scope).** Today `accountsEnabled()` refuses relay scope entirely. This adds a narrowed allowance:

- `GET /workspace/agent-profiles` answers in relay scope with `configDir` and `files` removed from every row.
- `POST` with `managed: true` is allowed. A client-supplied `configDir` is still refused.
- `DELETE` is allowed for managed rows only. A row counts as managed only when its `managed` flag is set
  **and** its folder is exactly its own `agent-homes/<provider>/<id>`, symlinks resolved (a hand-edited flag or
  path never authorizes a logout, a delete or a phone removal). A leftover folder at a new id is never adopted.
- `GET …/:id/status` and `GET …/:id/details` answer too, for every account including ones in the user's own
  folders: the wizard's Ready step shows who signed in and checks the other accounts of that agent for the same
  login. Neither carries a host path; `details` does carry the sign-in identity (e.g. email), deliberately.

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

## Decisions (owner, 2026-11-24)

1. **Placement**: the existing Add account button in Settings → Agents → Accounts opens the wizard. Settings gets no
   new page or button.
2. **No browser opened**: every method shows the link to copy. The reconnect card follows the same rule.
3. **Phone access**: yes. A paired phone gets the path-free, managed-only subset.
4. **Removing a managed account** logs it out and deletes its folder, and the confirm dialog names the folder.
5. **Pickers** offer "Add account…".
6. **OMP and Kimi**: phase 1 uses the terminal hand-off. On a phone the user finishes on the computer and presses
   *Check again*. Phase 2 adds a small terminal inside the cockpit with input, so they sign in without leaving it.
   The `cez account login <id>` command is dropped in favor of that.
